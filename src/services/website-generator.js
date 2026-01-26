import { GoogleGenerativeAI } from '@google/generative-ai';
import { promises as fs } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import prettier from 'prettier';
import { config } from '../config.js';
import { RestaurantModel, MaterialModel, NoteModel } from '../db/models/index.js';

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

export class WebsiteGenerator {
  constructor() {
    this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  }

  /**
   * Generate website for a restaurant using Gemini
   */
  async generate(restaurantId) {
    // Get full restaurant data
    const restaurant = RestaurantModel.getFullData(restaurantId);
    if (!restaurant) {
      throw new Error('Restaurant not found');
    }

    // Create output directory
    const outputDir = join(config.paths.websites, restaurantId);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(join(outputDir, 'images'), { recursive: true });

    // Process and copy images
    const processedPhotos = await this.processImages(restaurant.photos, outputDir);

    // Generate HTML files with Gemini
    const files = await this.generateHTML(restaurant, processedPhotos);

    // Write all HTML files (formatted)
    for (const [filename, html] of Object.entries(files)) {
      const formatted = await this.formatHTML(html);
      await fs.writeFile(join(outputDir, filename), formatted);
    }

    // Track generated material
    const material = MaterialModel.create(restaurantId, {
      type: 'website',
      filePath: outputDir
    });

    return {
      path: outputDir,
      materialId: material.id
    };
  }

  /**
   * Generate complete HTML using Gemini
   */
  async generateHTML(restaurant, photos) {
    const photoDescriptions = photos.map(p => ({
      path: p.webPath,
      type: p.type,
      caption: p.caption,
      isPrimary: p.isPrimary
    }));

    const menuData = restaurant.menu.map(cat => ({
      category: cat.name,
      items: cat.items.map(item => ({
        name: item.name,
        description: item.description,
        price: item.price
      }))
    }));

    // Get active notes (auto-filters expired ones)
    const activeNotes = NoteModel.getActive(restaurant.id);

    const prompt = `You are a world-class web designer. Generate a multi-page restaurant website.

RESTAURANT DATA:
- Name: ${restaurant.name || 'Restaurant'}
- Tagline: ${restaurant.tagline || ''}
- Description: ${restaurant.description || ''}
- Cuisine Type: ${restaurant.cuisine_type || 'Restaurant'}
- Address: ${restaurant.address || ''}
- Phone: ${restaurant.phone || ''}
- Email: ${restaurant.email || ''}
- Hours: ${JSON.stringify(restaurant.hours || {})}
- Style Preference: ${restaurant.style_theme || 'modern'}
- Brand Color: ${restaurant.primary_color || '#2563eb'}

MENU:
${JSON.stringify(menuData, null, 2)}

AVAILABLE PHOTOS (use these exact paths):
${JSON.stringify(photoDescriptions, null, 2)}

${activeNotes.length > 0 ? `SPECIAL NOTES/ANNOUNCEMENTS:
${activeNotes.map(n => `- ${n.content}`).join('\n')}
` : ''}

GENERATE TWO HTML FILES:

===FILE:index.html===
Landing page with: Hero, About, Gallery (if photos), Contact/Hours, Footer
- Link to menu.html with a prominent "View Menu" or "Order Now" button
- In Contact section, include <div id="google-map"></div> for map embed

===FILE:menu.html===
Full menu page with ordering:
- Navigation back to index.html
- Full menu organized by category
- Each item needs: name, description, price, Add to Cart button
- Add to Cart buttons: class="add-to-cart-btn" with data-item-id, data-name, data-price attributes

DESIGN REQUIREMENTS:
1. Each file is COMPLETE with embedded CSS in <style> tags
2. Mobile-first, fully responsive
3. Design matches the cuisine type (Italian=warm/elegant, Japanese=minimal/zen, Mexican=vibrant, etc.)
4. Use Google Fonts that fit the vibe
5. Brand color as primary accent
6. Consistent header/footer across both pages
7. If using hover effects on cards, ensure padding and border-radius so hovers look polished
8. DO NOT add any JavaScript for cart - it will be injected separately

CART UI STYLING - The cart HTML will be injected automatically. You only need to add CSS for these selectors to match your design:
- #cart-fab: Floating cart button (fixed bottom-right). Style: background, color, border-radius, shadow
- #cart-count: Badge showing item count (positioned on cart-fab). Style: background, color
- #cart-panel: Slide-out panel from right. Style: background, colors, fonts
- #cart-header, #cart-close: Panel header. Style to match
- #checkout-btn: Checkout button. Style: background, color, border-radius, hover states
- .cart-item, .cart-item-name, .cart-item-price: Item rows in cart
DO NOT generate any cart HTML elements - only include CSS rules for the above selectors in your stylesheet.

ANIMATION CLASSES (pre-loaded, just add them):
- "animate-hero", "animate-hero-delayed" for hero text
- "animate-fade-up" for sections
- "animate-scale-in" with "stagger-1", "stagger-2" for cards
- "hover-press" for buttons, "hover-lift" for cards

OUTPUT FORMAT - Return exactly this structure, no markdown:
===FILE:index.html===
<!DOCTYPE html>
...complete index.html...
</html>
===FILE:menu.html===
<!DOCTYPE html>
...complete menu.html...
</html>`;

    const result = await this.model.generateContent(prompt);
    let response = result.response.text();

    // Clean up any markdown
    response = response.replace(/^```html\n?/i, '').replace(/\n?```$/i, '').trim();

    // Parse multiple files from response
    const files = this.parseMultipleFiles(response);

    // Process each file
    for (const [filename, content] of Object.entries(files)) {
      let html = content;

      // Ensure it starts with doctype
      if (!html.toLowerCase().startsWith('<!doctype')) {
        html = '<!DOCTYPE html>\n' + html;
      }

      // Inject animations on all pages
      html = this.injectAnimations(html);

      // Only inject cart on menu.html
      if (filename === 'menu.html') {
        html = this.injectOrderingSystem(html, restaurant.id);
      }

      // Inject Google Maps on index.html (where contact section is)
      if (filename === 'index.html' && restaurant.address && config.google?.mapsApiKey) {
        html = this.injectGoogleMap(html, restaurant.address);
      }

      files[filename] = html;
    }

    return files;
  }

  /**
   * Parse multiple files from Gemini response
   */
  parseMultipleFiles(response) {
    const files = {};
    const filePattern = /===FILE:(\w+\.html)===([\s\S]*?)(?====FILE:|$)/g;
    let match;

    while ((match = filePattern.exec(response)) !== null) {
      const filename = match[1];
      let content = match[2].trim();
      files[filename] = content;
    }

    // Fallback: if no files parsed, treat entire response as index.html
    if (Object.keys(files).length === 0) {
      files['index.html'] = response;
    }

    return files;
  }

  /**
   * Inject Google Maps embed
   */
  injectGoogleMap(html, address) {
    const apiKey = config.google.mapsApiKey;
    const encodedAddress = encodeURIComponent(address);

    const mapCSS = `
<style>
#google-map {
  width: 100%;
  height: 300px;
  border-radius: 8px;
  overflow: hidden;
  margin: 20px 0;
}
#google-map iframe {
  width: 100%;
  height: 100%;
  border: 0;
}
@media (min-width: 768px) {
  #google-map {
    height: 400px;
  }
}
</style>`;

    const mapIframe = `<iframe
  loading="lazy"
  allowfullscreen
  referrerpolicy="no-referrer-when-downgrade"
  src="https://www.google.com/maps/embed/v1/place?key=${apiKey}&q=${encodedAddress}">
</iframe>`;

    // Inject CSS before </head>
    if (html.includes('</head>')) {
      html = html.replace('</head>', mapCSS + '\n</head>');
    }

    // Replace the placeholder div with the iframe
    if (html.includes('id="google-map"')) {
      html = html.replace(/<div[^>]*id="google-map"[^>]*>[\s\S]*?<\/div>/i,
        `<div id="google-map">${mapIframe}</div>`);
    } else {
      // If no placeholder, try to inject before </footer> or </body>
      const mapSection = `
<div id="google-map" style="max-width: 1200px; margin: 0 auto; padding: 20px;">
  ${mapIframe}
</div>`;
      if (html.includes('</footer>')) {
        html = html.replace('</footer>', mapSection + '\n</footer>');
      } else if (html.includes('</main>')) {
        html = html.replace('</main>', mapSection + '\n</main>');
      }
    }

    return html;
  }

  /**
   * Inject animation CSS and Intersection Observer script into generated HTML
   */
  injectAnimations(html) {
    // Animation CSS to inject
    const animationCSS = `
<style>
/* Animation Utilities - Based on Emil Kowalski's best practices */
:root {
  --ease-out-quad: cubic-bezier(0.25, 0.46, 0.45, 0.94);
  --ease-out-cubic: cubic-bezier(0.215, 0.61, 0.355, 1);
  --ease-out-quart: cubic-bezier(0.165, 0.84, 0.44, 1);
  --ease-out-quint: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out-cubic: cubic-bezier(0.645, 0.045, 0.355, 1);
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
}

/* Scroll-triggered animations */
.animate-fade-up { opacity: 0; transform: translateY(20px); transition: opacity var(--duration-slow) var(--ease-out-quart), transform var(--duration-slow) var(--ease-out-quart); }
.animate-fade-up.is-visible { opacity: 1; transform: translateY(0); }
.animate-fade-in { opacity: 0; transition: opacity var(--duration-slow) var(--ease-out-cubic); }
.animate-fade-in.is-visible { opacity: 1; }
.animate-scale-in { opacity: 0; transform: scale(0.95); transition: opacity var(--duration-normal) var(--ease-out-quart), transform var(--duration-normal) var(--ease-out-quart); }
.animate-scale-in.is-visible { opacity: 1; transform: scale(1); }
.animate-slide-left { opacity: 0; transform: translateX(-30px); transition: opacity var(--duration-slow) var(--ease-out-quart), transform var(--duration-slow) var(--ease-out-quart); }
.animate-slide-left.is-visible { opacity: 1; transform: translateX(0); }
.animate-slide-right { opacity: 0; transform: translateX(30px); transition: opacity var(--duration-slow) var(--ease-out-quart), transform var(--duration-slow) var(--ease-out-quart); }
.animate-slide-right.is-visible { opacity: 1; transform: translateX(0); }

/* Stagger delays */
.stagger-1 { transition-delay: 50ms; }
.stagger-2 { transition-delay: 100ms; }
.stagger-3 { transition-delay: 150ms; }
.stagger-4 { transition-delay: 200ms; }
.stagger-5 { transition-delay: 250ms; }
.stagger-6 { transition-delay: 300ms; }

/* Hover effects */
.hover-press { transition: transform var(--duration-fast) var(--ease-out-cubic); will-change: transform; }
@media (hover: hover) and (pointer: fine) { .hover-press:hover { transform: scale(1.02); } }
.hover-press:active { transform: scale(0.97); }
.hover-lift { transition: transform var(--duration-normal) var(--ease-out-cubic), box-shadow var(--duration-normal) ease; will-change: transform; }
@media (hover: hover) and (pointer: fine) { .hover-lift:hover { transform: translateY(-4px); box-shadow: 0 12px 24px rgba(0,0,0,0.15); } }
.hover-zoom { overflow: hidden; }
.hover-zoom img { transition: transform var(--duration-slow) var(--ease-out-cubic); will-change: transform; }
@media (hover: hover) and (pointer: fine) { .hover-zoom:hover img { transform: scale(1.05); } }
.hover-underline { position: relative; text-decoration: none; }
.hover-underline::after { content: ''; position: absolute; bottom: -2px; left: 0; width: 100%; height: 2px; background: currentColor; transform: scaleX(0); transform-origin: right; transition: transform var(--duration-normal) var(--ease-out-cubic); }
@media (hover: hover) and (pointer: fine) { .hover-underline:hover::after { transform: scaleX(1); transform-origin: left; } }

/* Hero animations */
@keyframes hero-fade-in { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
.animate-hero { animation: hero-fade-in 800ms var(--ease-out-quint) forwards; }
.animate-hero-delayed { opacity: 0; animation: hero-fade-in 800ms var(--ease-out-quint) 200ms forwards; }
.animate-hero-delayed-2 { opacity: 0; animation: hero-fade-in 800ms var(--ease-out-quint) 400ms forwards; }

/* Smooth scroll */
html { scroll-behavior: smooth; }

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
  .animate-fade-up, .animate-fade-in, .animate-scale-in, .animate-slide-left, .animate-slide-right { opacity: 1; transform: none; }
}
</style>`;

    // Intersection Observer script to trigger animations
    const animationScript = `
<script>
// Intersection Observer for scroll animations
document.addEventListener('DOMContentLoaded', function() {
  const animatedElements = document.querySelectorAll('.animate-fade-up, .animate-fade-in, .animate-scale-in, .animate-slide-left, .animate-slide-right');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

    animatedElements.forEach(function(el) { observer.observe(el); });
  } else {
    // Fallback for older browsers
    animatedElements.forEach(function(el) { el.classList.add('is-visible'); });
  }
});
</script>`;

    // Inject CSS before </head>
    if (html.includes('</head>')) {
      html = html.replace('</head>', animationCSS + '\n</head>');
    } else {
      // If no head tag, inject after doctype
      html = html.replace(/(<html[^>]*>)/i, '$1\n<head>' + animationCSS + '</head>');
    }

    // Inject script before </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', animationScript + '\n</body>');
    } else {
      // If no body closing tag, append at end
      html = html.replace('</html>', animationScript + '\n</html>');
    }

    return html;
  }

  /**
   * Inject ordering system (cart UI and Stripe checkout)
   */
  injectOrderingSystem(html, restaurantId) {
    // Cart CSS - only essential layout/behavior, theming comes from Gemini
    const cartCSS = `
<style>
/* Cart - Layout & Behavior Only (theming from page styles) */
#cart-fab {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 1000;
  cursor: pointer;
}
#cart-count {
  position: absolute;
  top: -4px;
  right: -4px;
}
#cart-count:empty, #cart-count[data-count="0"] {
  display: none;
}
#cart-overlay {
  position: fixed;
  inset: 0;
  z-index: 1001;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.3s ease, visibility 0.3s ease;
}
#cart-overlay.open {
  opacity: 1;
  visibility: visible;
}
#cart-panel {
  position: fixed;
  top: 0;
  right: 0;
  height: 100%;
  z-index: 1002;
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.23, 1, 0.32, 1);
}
#cart-panel.open {
  transform: translateX(0);
}
#cart-items {
  flex: 1;
  overflow-y: auto;
}
.cart-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.cart-item-info {
  flex: 1;
}
.cart-item-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.qty-btn {
  cursor: pointer;
}
#checkout-btn {
  width: 100%;
  cursor: pointer;
}
#checkout-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Add to Cart Button */
.add-to-cart-btn {
  cursor: pointer;
  transition: transform 0.15s ease;
}
.add-to-cart-btn:active {
  transform: scale(0.97);
}

/* Toast notification */
#cart-toast {
  position: fixed;
  bottom: 100px;
  right: 24px;
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 0.9rem;
  z-index: 1003;
  opacity: 0;
  transform: translateY(10px);
  transition: opacity 0.3s ease, transform 0.3s ease;
  pointer-events: none;
}
#cart-toast.show {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 480px) {
  #cart-panel {
    max-width: 100%;
  }
}
</style>`;

    // Cart HTML
    const cartHTML = `
<div id="cart-overlay" onclick="closeCart()"></div>
<div id="cart-panel">
  <div id="cart-header">
    <h2>Your Order</h2>
    <button id="cart-close" onclick="closeCart()">&times;</button>
  </div>
  <div id="cart-items">
    <div id="cart-empty">Your cart is empty</div>
  </div>
  <div id="cart-footer">
    <div class="cart-subtotal">
      <span class="cart-subtotal-label">Subtotal</span>
      <span class="cart-subtotal-value" id="cart-subtotal">$0.00</span>
    </div>
    <button id="checkout-btn" onclick="checkout()" disabled>
      <span>Checkout</span>
      <span>🔒</span>
    </button>
  </div>
</div>
<div id="cart-fab" onclick="toggleCart()">
  🛒
  <span id="cart-count" data-count="0"></span>
</div>
<div id="cart-toast"></div>`;

    // Cart JavaScript
    const cartJS = `
<script src="https://js.stripe.com/v3/"></script>
<script>
(function() {
  const RESTAURANT_ID = '${restaurantId}';
  const STORAGE_KEY = 'cart_' + RESTAURANT_ID;

  // Cart state
  let cart = [];

  // Load cart from localStorage
  function loadCart() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      cart = saved ? JSON.parse(saved) : [];
    } catch (e) {
      cart = [];
    }
    renderCart();
  }

  // Save cart to localStorage
  function saveCart() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
  }

  // Add item to cart
  window.addToCart = function(id, name, price) {
    const existing = cart.find(item => item.id === id);
    if (existing) {
      existing.quantity++;
    } else {
      cart.push({ id, name, price: parseFloat(price), quantity: 1 });
    }
    saveCart();
    renderCart();
    showToast(name + ' added to cart');

    // Visual feedback on button
    const btn = document.querySelector('[data-item-id="' + id + '"]');
    if (btn) {
      btn.classList.add('added');
      btn.textContent = 'Added!';
      setTimeout(() => {
        btn.classList.remove('added');
        btn.textContent = 'Add to Cart';
      }, 1000);
    }
  };

  // Remove item from cart
  window.removeFromCart = function(id) {
    cart = cart.filter(item => item.id !== id);
    saveCart();
    renderCart();
  };

  // Update quantity
  window.updateQuantity = function(id, delta) {
    const item = cart.find(item => item.id === id);
    if (item) {
      item.quantity += delta;
      if (item.quantity <= 0) {
        removeFromCart(id);
      } else {
        saveCart();
        renderCart();
      }
    }
  };

  // Get cart total
  function getSubtotal() {
    return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  }

  // Get total item count
  function getItemCount() {
    return cart.reduce((sum, item) => sum + item.quantity, 0);
  }

  // Render cart
  function renderCart() {
    const container = document.getElementById('cart-items');
    const subtotalEl = document.getElementById('cart-subtotal');
    const countEl = document.getElementById('cart-count');
    const checkoutBtn = document.getElementById('checkout-btn');
    const emptyEl = document.getElementById('cart-empty');

    if (cart.length === 0) {
      container.innerHTML = '<div id="cart-empty">Your cart is empty</div>';
      subtotalEl.textContent = '$$0.00';
      countEl.textContent = '';
      countEl.dataset.count = '0';
      checkoutBtn.disabled = true;
      return;
    }

    let html = '';
    cart.forEach(item => {
      const itemTotal = (item.price * item.quantity).toFixed(2);
      html += '<div class="cart-item">' +
        '<div class="cart-item-info">' +
          '<div class="cart-item-name">' + escapeHtml(item.name) + '</div>' +
          '<div class="cart-item-price">$$' + item.price.toFixed(2) + ' each</div>' +
        '</div>' +
        '<div class="cart-item-controls">' +
          '<button class="qty-btn" onclick="updateQuantity(\\'' + item.id + '\\', -1)">−</button>' +
          '<span class="cart-item-qty">' + item.quantity + '</span>' +
          '<button class="qty-btn" onclick="updateQuantity(\\'' + item.id + '\\', 1)">+</button>' +
          '<span class="cart-item-total">$$' + itemTotal + '</span>' +
          '<button class="cart-item-remove" onclick="removeFromCart(\\'' + item.id + '\\')">&times;</button>' +
        '</div>' +
      '</div>';
    });

    container.innerHTML = html;
    subtotalEl.textContent = '$$' + getSubtotal().toFixed(2);

    const count = getItemCount();
    countEl.textContent = count;
    countEl.dataset.count = count;
    checkoutBtn.disabled = false;
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Toggle cart panel
  window.toggleCart = function() {
    const panel = document.getElementById('cart-panel');
    const overlay = document.getElementById('cart-overlay');
    panel.classList.toggle('open');
    overlay.classList.toggle('open');
  };

  // Close cart
  window.closeCart = function() {
    document.getElementById('cart-panel').classList.remove('open');
    document.getElementById('cart-overlay').classList.remove('open');
  };

  // Show toast
  function showToast(message) {
    const toast = document.getElementById('cart-toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }

  // Checkout
  window.checkout = async function() {
    if (cart.length === 0) return;

    const checkoutBtn = document.getElementById('checkout-btn');
    checkoutBtn.disabled = true;
    checkoutBtn.innerHTML = '<span>Processing...</span>';

    try {
      const response = await fetch('/api/orders/' + RESTAURANT_ID + '/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart,
          successUrl: window.location.origin + window.location.pathname,
          cancelUrl: window.location.href
        })
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error);
      }

      // Clear cart before redirect
      localStorage.removeItem(STORAGE_KEY);

      // Redirect to Stripe Checkout
      window.location.href = data.url;
    } catch (error) {
      console.error('Checkout error:', error);
      showToast('Checkout failed. Please try again.');
      checkoutBtn.disabled = false;
      checkoutBtn.innerHTML = '<span>Checkout</span><span>🔒</span>';
    }
  };

  // Check for order confirmation
  function checkOrderConfirmation() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('order');
    if (sessionId) {
      // Remove order param from URL
      const url = new URL(window.location);
      url.searchParams.delete('order');
      window.history.replaceState({}, '', url);

      // Show confirmation
      showOrderConfirmation(sessionId);
    }
  }

  function showOrderConfirmation(sessionId) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000;';
    modal.innerHTML = '<div style="background:white;padding:40px;border-radius:16px;text-align:center;max-width:400px;margin:20px;">' +
      '<div style="font-size:48px;margin-bottom:16px;">✅</div>' +
      '<h2 style="margin:0 0 12px;color:#111;">Order Confirmed!</h2>' +
      '<p style="color:#6b7280;margin:0 0 24px;">Thank you for your order. You will receive a confirmation email shortly.</p>' +
      '<button onclick="this.closest(\\'div\\').parentElement.remove()" style="padding:12px 32px;background:var(--primary-color,#2563eb);color:white;border:none;border-radius:8px;font-size:1rem;cursor:pointer;">Continue</button>' +
    '</div>';
    document.body.appendChild(modal);
  }

  // Wire up Add to Cart buttons using event delegation
  // This ensures our handler works even if Gemini added its own handlers
  function initAddToCartButtons() {
    document.body.addEventListener('click', function(e) {
      const btn = e.target.closest('.add-to-cart-btn');
      if (btn) {
        e.stopPropagation();
        const id = btn.dataset.itemId;
        const name = btn.dataset.name;
        const price = btn.dataset.price;
        if (id && name && price) {
          addToCart(id, name, price);
        }
      }
    }, true); // Use capture phase to run first
  }

  // Initialize
  document.addEventListener('DOMContentLoaded', function() {
    loadCart();
    initAddToCartButtons();
    checkOrderConfirmation();
  });
})();
</script>`;

    // Inject CSS before </head>
    if (html.includes('</head>')) {
      html = html.replace('</head>', cartCSS + '\n</head>');
    }

    // Inject HTML and JS before </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', cartHTML + '\n' + cartJS + '\n</body>');
    }

    return html;
  }

  /**
   * Process and optimize images
   */
  async processImages(photos, outputDir) {
    const processed = [];

    for (const photo of photos) {
      try {
        const filename = `${photo.id}.jpg`;
        const outputPath = join(outputDir, 'images', filename);

        await sharp(photo.path)
          .resize(1200, 800, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 85 })
          .toFile(outputPath);

        // Also create thumbnail
        const thumbPath = join(outputDir, 'images', `${photo.id}_thumb.jpg`);
        await sharp(photo.path)
          .resize(400, 300, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 80 })
          .toFile(thumbPath);

        processed.push({
          ...photo,
          webPath: `images/${filename}`,
          thumbPath: `images/${photo.id}_thumb.jpg`
        });
      } catch (error) {
        console.error(`Failed to process image ${photo.path}:`, error);
      }
    }

    return processed;
  }

  /**
   * Format HTML with prettier for consistent output
   */
  async formatHTML(html) {
    try {
      return await prettier.format(html, {
        parser: 'html',
        printWidth: 120,
        tabWidth: 2,
        useTabs: false
      });
    } catch (error) {
      console.warn('HTML formatting failed, using raw HTML:', error.message);
      return html;
    }
  }
}
