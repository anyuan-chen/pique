/**
 * Restaurant Onboarding Flow
 * Search → Select → Check → (Upload if needed) → Confirm Menu → Main App
 */

class OnboardingFlow {
  constructor() {
    this.currentScreen = 'search';
    this.restaurantId = null;
    this.selectedPlace = null;
    this.searchTimeout = null;
    this.menuItems = [];
    this.removedItems = new Set();

    // DOM elements
    this.searchInput = document.getElementById('search-input');
    this.resultsEl = document.getElementById('results');
    this.checkingNameEl = document.getElementById('checking-name');
    this.uploadArea = document.getElementById('upload-area');
    this.videoInput = document.getElementById('video-input');
    this.progressFill = document.getElementById('progress-fill');
    this.progressText = document.getElementById('progress-text');
    this.processingStatus = document.getElementById('processing-status');
    this.menuItemsEl = document.getElementById('menu-items');
    this.menuSummaryEl = document.getElementById('menu-summary');
    this.confirmBtn = document.getElementById('confirm-btn');
    this.addItemBtn = document.getElementById('add-item-btn');

    this.bindEvents();
  }

  bindEvents() {
    // Search input with debounce
    this.searchInput.addEventListener('input', () => {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = setTimeout(() => {
        this.searchPlaces(this.searchInput.value);
      }, 300);
    });

    // Upload area click
    this.uploadArea.addEventListener('click', () => {
      this.videoInput.click();
    });

    // Video file selected
    this.videoInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        this.uploadVideo(file);
      }
    });

    // Menu confirmation buttons
    if (this.confirmBtn) {
      this.confirmBtn.addEventListener('click', () => {
        this.confirmMenu();
      });
    }

    if (this.addItemBtn) {
      this.addItemBtn.addEventListener('click', () => {
        this.addNewItem();
      });
    }
  }

  showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`screen-${name}`).classList.add('active');
    this.currentScreen = name;
  }

  async searchPlaces(query) {
    if (!query || query.length < 2) {
      this.resultsEl.innerHTML = '';
      return;
    }

    try {
      const res = await fetch(`/api/onboard/search?q=${encodeURIComponent(query)}`);
      const { predictions, error } = await res.json();

      if (error) {
        this.resultsEl.innerHTML = `<div class="no-results">${error}</div>`;
        return;
      }

      if (!predictions || predictions.length === 0) {
        this.resultsEl.innerHTML = '<div class="no-results">No restaurants found</div>';
        return;
      }

      this.resultsEl.innerHTML = predictions.map(p => `
        <div class="result-item" data-place='${JSON.stringify(p).replace(/'/g, "&#39;")}'>
          <div class="result-info">
            <div class="result-name">${this.escapeHtml(p.name)}</div>
            <div class="result-address">${this.escapeHtml(p.address)}</div>
          </div>
          <i data-lucide="chevron-right" class="result-arrow" width="20" height="20"></i>
        </div>
      `).join('');

      // Re-render icons and bind click events
      lucide.createIcons();
      this.resultsEl.querySelectorAll('.result-item').forEach(item => {
        item.addEventListener('click', () => {
          const place = JSON.parse(item.dataset.place);
          this.selectPlace(place);
        });
      });
    } catch (err) {
      console.error('Search error:', err);
      this.resultsEl.innerHTML = '<div class="no-results">Search failed</div>';
    }
  }

  async selectPlace(place) {
    this.selectedPlace = place;
    this.checkingNameEl.textContent = place.name;
    this.showScreen('checking');

    try {
      const res = await fetch('/api/onboard/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeId: place.placeId, name: place.name })
      });

      const { exists, restaurantId, hasData, placeData, error } = await res.json();

      if (error) {
        alert(error);
        this.showScreen('search');
        return;
      }

      if (exists && hasData) {
        // Restaurant exists with data - go straight to main app
        this.redirectToMain(restaurantId);
      } else if (exists && !hasData) {
        // Restaurant exists but needs video content
        this.restaurantId = restaurantId;
        this.showScreen('upload');
      } else {
        // New restaurant - create it first, then upload
        const createRes = await fetch('/api/onboard/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ placeId: place.placeId, placeData })
        });

        const { restaurantId: newId, error: createError } = await createRes.json();

        if (createError) {
          alert(createError);
          this.showScreen('search');
          return;
        }

        this.restaurantId = newId;
        this.showScreen('upload');
      }
    } catch (err) {
      console.error('Check error:', err);
      alert('Something went wrong. Please try again.');
      this.showScreen('search');
    }
  }

  async uploadVideo(file) {
    this.showScreen('processing');
    this.updateProgress(0, 'Uploading video...');

    try {
      const form = new FormData();
      form.append('video', file);
      if (this.restaurantId) {
        form.append('restaurantId', this.restaurantId);
      }

      const res = await fetch('/api/upload/video', {
        method: 'POST',
        body: form
      });

      const { jobId, error } = await res.json();

      if (error) {
        alert(error);
        this.showScreen('upload');
        return;
      }

      // Poll for completion
      const result = await this.pollUntilComplete(jobId);

      // Show confirmation screen or redirect
      if (result === 'needs_review') {
        await this.showConfirmScreen();
      } else {
        // Still show confirm screen to let user verify
        await this.showConfirmScreen();
      }
    } catch (err) {
      console.error('Upload error:', err);
      alert('Upload failed. Please try again.');
      this.showScreen('upload');
    }
  }

  async pollUntilComplete(jobId) {
    while (true) {
      try {
        const res = await fetch(`/api/upload/status/${jobId}`);
        const { status, progress, restaurantId, missingFields, error } = await res.json();

        if (status === 'failed') {
          throw new Error(error || 'Processing failed');
        }

        if (status === 'completed') {
          // Update restaurantId from job in case it was set during processing
          if (restaurantId) {
            this.restaurantId = restaurantId;
          }
          this.updateProgress(100, 'Complete!');
          await this.delay(500);

          // Check if menu review is needed
          if (missingFields && missingFields.includes('menu_review')) {
            return 'needs_review';
          }
          return 'complete';
        }

        // Show progress-based status messages
        const message = this.getProgressMessage(progress || 0);
        this.updateProgress(progress || 0, message);

        await this.delay(1000);
      } catch (err) {
        console.error('Poll error:', err);
        throw err;
      }
    }
  }

  getProgressMessage(progress) {
    if (progress < 15) return 'Uploading video...';
    if (progress < 35) return 'Extracting key frames...';
    if (progress < 65) return 'Analyzing with AI...';
    if (progress < 75) return 'Identifying menu items...';
    if (progress < 85) return 'Processing photos...';
    if (progress < 95) return 'Finalizing...';
    return 'Almost done...';
  }

  updateProgress(percent, message) {
    this.progressFill.style.width = `${percent}%`;
    this.progressText.textContent = `${Math.round(percent)}%`;
    if (message) {
      this.processingStatus.textContent = message;
    }
  }

  redirectToMain(restaurantId) {
    window.location.href = `/voice.html?restaurantId=${restaurantId}`;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Menu confirmation methods
  async showConfirmScreen() {
    try {
      const res = await fetch(`/api/onboard/menu/${this.restaurantId}`);
      const { menuItems, error } = await res.json();

      if (error) {
        console.error('Failed to fetch menu:', error);
        this.redirectToMain(this.restaurantId);
        return;
      }

      this.menuItems = menuItems || [];
      this.removedItems.clear();
      this.renderMenuItems();
      this.showScreen('confirm');
    } catch (err) {
      console.error('Show confirm error:', err);
      this.redirectToMain(this.restaurantId);
    }
  }

  renderMenuItems() {
    const needsReviewCount = this.menuItems.filter(item => item.needsReview).length;
    const totalCount = this.menuItems.length;

    this.menuSummaryEl.innerHTML = `
      Found <strong>${totalCount}</strong> items${needsReviewCount > 0 ? ` (<strong>${needsReviewCount}</strong> need review)` : ''}
    `;

    this.menuItemsEl.innerHTML = this.menuItems.map((item, index) => {
      const isRemoved = this.removedItems.has(item.id);
      const statusClass = item.needsReview ? 'needs-review' : '';
      const removedClass = isRemoved ? 'removed' : '';

      return `
        <div class="menu-item ${statusClass} ${removedClass}" data-id="${item.id}" data-index="${index}">
          <div class="item-info">
            <span class="item-name" contenteditable="${!isRemoved}" data-field="name">${this.escapeHtml(item.name)}</span>
            <div class="item-details">
              <span class="item-price" contenteditable="${!isRemoved}" data-field="price">${item.price ? '$' + item.price : 'No price'}</span>
              <span class="item-category">${this.escapeHtml(item.category || 'Uncategorized')}</span>
            </div>
          </div>
          <div class="item-status">
            ${item.needsReview
              ? '<span class="status-badge review"><i data-lucide="alert-circle" width="12" height="12"></i> Review</span>'
              : '<span class="status-badge confirmed"><i data-lucide="check" width="12" height="12"></i></span>'}
          </div>
          <button class="remove-btn" data-action="${isRemoved ? 'restore' : 'remove'}">${isRemoved ? '+' : '×'}</button>
        </div>
      `;
    }).join('');

    // Re-render icons
    lucide.createIcons();

    // Bind remove/restore buttons
    this.menuItemsEl.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const itemEl = e.target.closest('.menu-item');
        const itemId = itemEl.dataset.id;
        const action = e.target.dataset.action;

        if (action === 'remove') {
          this.removedItems.add(itemId);
        } else {
          this.removedItems.delete(itemId);
        }
        this.renderMenuItems();
      });
    });

    // Track edits in contenteditable fields
    this.menuItemsEl.querySelectorAll('[contenteditable="true"]').forEach(el => {
      el.addEventListener('blur', (e) => {
        const itemEl = e.target.closest('.menu-item');
        const index = parseInt(itemEl.dataset.index);
        const field = e.target.dataset.field;
        let value = e.target.textContent.trim();

        if (field === 'price') {
          // Parse price, removing $ sign
          value = parseFloat(value.replace(/[^0-9.]/g, '')) || null;
        }

        if (this.menuItems[index]) {
          this.menuItems[index][field] = value;
          // Mark as no longer needing review if user edited it
          this.menuItems[index].needsReview = false;
        }
      });
    });
  }

  addNewItem() {
    const newItem = {
      id: 'new-' + Date.now(),
      name: 'New Item',
      description: null,
      category: 'Uncategorized',
      price: null,
      needsReview: true,
      isNew: true
    };

    this.menuItems.unshift(newItem);
    this.renderMenuItems();

    // Focus on the new item's name
    const firstItem = this.menuItemsEl.querySelector('.menu-item .item-name');
    if (firstItem) {
      firstItem.focus();
      // Select all text
      const range = document.createRange();
      range.selectNodeContents(firstItem);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  collectEditedItems() {
    return this.menuItems
      .filter(item => !this.removedItems.has(item.id))
      .map(item => ({
        id: item.isNew ? null : item.id,
        name: item.name,
        description: item.description,
        category: item.category,
        price: item.price,
        dietaryTags: item.dietaryTags || []
      }));
  }

  async confirmMenu() {
    const items = this.collectEditedItems();
    const removedIds = Array.from(this.removedItems).filter(id => !id.startsWith('new-'));

    try {
      this.confirmBtn.textContent = 'Saving...';
      this.confirmBtn.disabled = true;

      await fetch(`/api/onboard/menu/${this.restaurantId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, removedIds })
      });

      // Start website generation (async - returns jobId)
      this.confirmBtn.textContent = 'Generating website...';
      const genRes = await fetch(`/api/deploy/generate/website/${this.restaurantId}`, { method: 'POST' });
      const genData = await genRes.json();

      // Redirect to reveal page with job tracking
      const revealParams = new URLSearchParams({
        restaurantId: this.restaurantId,
        name: this.selectedPlace?.name || ''
      });
      if (genData.jobId) {
        revealParams.set('jobId', genData.jobId);
      }
      window.location.href = `/reveal.html?${revealParams}`;
    } catch (err) {
      console.error('Confirm error:', err);
      alert('Failed to save menu. Please try again.');
      this.confirmBtn.textContent = 'Looks good';
      this.confirmBtn.disabled = false;
    }
  }
}

// Initialize
const app = new OnboardingFlow();
