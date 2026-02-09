import { Router } from 'express';
import { config } from '../config.js';
import { RestaurantModel, MenuCategoryModel, MenuItemModel } from '../db/models/index.js';

const router = Router();

// Search Google Places for restaurants
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.json({ predictions: [] });
    }

    const apiKey = config.google.mapsApiKey;
    if (!apiKey) {
      return res.status(500).json({ error: 'Google Maps API key not configured' });
    }

    // Use Places API (New) - Text Search
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress'
      },
      body: JSON.stringify({
        textQuery: q,
        includedType: 'restaurant',
        maxResultCount: 5
      })
    });
    const data = await response.json();

    if (data.error) {
      console.error('Places API error:', data.error.message);
      return res.status(500).json({ error: 'Places search failed' });
    }

    const predictions = (data.places || []).map(p => ({
      placeId: p.id,
      name: p.displayName?.text || '',
      address: p.formattedAddress || ''
    }));

    res.json({ predictions });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check if restaurant exists and has data
router.post('/check', async (req, res) => {
  try {
    const { placeId, name } = req.body;
    if (!placeId) {
      return res.status(400).json({ error: 'placeId required' });
    }

    const apiKey = config.google.mapsApiKey;
    if (!apiKey) {
      return res.status(500).json({ error: 'Google Maps API key not configured' });
    }

    // Check if restaurant already exists in DB
    const existing = RestaurantModel.findByPlaceId(placeId);

    // Fetch place details from Google (New API)
    const detailsResponse = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'displayName,formattedAddress,nationalPhoneNumber,regularOpeningHours,websiteUri,rating'
      }
    });
    const detailsData = await detailsResponse.json();

    let placeData = null;
    if (detailsData.displayName) {
      placeData = {
        name: detailsData.displayName?.text || name,
        address: detailsData.formattedAddress || '',
        phone: detailsData.nationalPhoneNumber || '',
        website: detailsData.websiteUri || '',
        rating: detailsData.rating || null,
        hours: parseOpeningHours(detailsData.regularOpeningHours)
      };
    }

    if (existing) {
      const hasData = RestaurantModel.hasData(existing.id);
      res.json({
        exists: true,
        restaurantId: existing.id,
        hasData,
        placeData
      });
    } else {
      res.json({
        exists: false,
        restaurantId: null,
        hasData: false,
        placeData
      });
    }
  } catch (error) {
    console.error('Check error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new restaurant from Google Places data
router.post('/create', async (req, res) => {
  try {
    const { placeId, placeData } = req.body;
    if (!placeId) {
      return res.status(400).json({ error: 'placeId required' });
    }

    // Check if already exists
    const existing = RestaurantModel.findByPlaceId(placeId);
    if (existing) {
      return res.json({ restaurantId: existing.id });
    }

    // Create new restaurant with Google Places data
    const restaurant = RestaurantModel.create({
      googlePlaceId: placeId,
      name: placeData?.name || null,
      address: placeData?.address || null,
      phone: placeData?.phone || null,
      websiteUrl: placeData?.website || null,
      hours: placeData?.hours || null
    });

    res.json({ restaurantId: restaurant.id });
  } catch (error) {
    console.error('Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Parse Google opening hours to our format (supports both legacy and new API)
function parseOpeningHours(openingHours) {
  if (!openingHours) return null;

  // New API format: regularOpeningHours.weekdayDescriptions
  const descriptions = openingHours.weekdayDescriptions || openingHours.weekday_text;
  if (!descriptions) return null;

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const hours = {};

  for (const text of descriptions) {
    // Format: "Monday: 9:00 AM – 10:00 PM"
    const match = text.match(/^(\w+):\s*(.+)$/);
    if (match) {
      const day = match[1].toLowerCase();
      const time = match[2];
      if (days.includes(day)) {
        hours[day] = time;
      }
    }
  }

  return Object.keys(hours).length > 0 ? hours : null;
}

// Get menu items for confirmation
router.get('/menu/:restaurantId', (req, res) => {
  try {
    const { restaurantId } = req.params;

    // Get all categories for this restaurant
    const categories = MenuCategoryModel.getByRestaurant(restaurantId);

    // Get all items with their category info
    const menuItems = [];
    for (const category of categories) {
      const items = MenuItemModel.getByCategory(category.id);
      for (const item of items) {
        menuItems.push({
          id: item.id,
          name: item.name,
          description: item.description,
          category: category.name,
          categoryId: category.id,
          price: item.price,
          dietaryTags: item.dietaryTags || [],
          needsReview: false // Will be set by extraction if needed
        });
      }
    }

    res.json({ menuItems });
  } catch (error) {
    console.error('Get menu error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update confirmed menu items
router.put('/menu/:restaurantId', (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { items, removedIds } = req.body;

    // Delete removed items
    if (removedIds && removedIds.length > 0) {
      for (const id of removedIds) {
        MenuItemModel.delete(id);
      }
    }

    // Get existing categories
    const existingCategories = MenuCategoryModel.getByRestaurant(restaurantId);
    const categoryMap = new Map(existingCategories.map(c => [c.name, c.id]));

    // Update or create items
    for (const item of items) {
      // Ensure category exists
      let categoryId = categoryMap.get(item.category);
      if (!categoryId) {
        const newCategory = MenuCategoryModel.create(restaurantId, { name: item.category });
        categoryId = newCategory.id;
        categoryMap.set(item.category, categoryId);
      }

      if (item.id) {
        // Update existing item
        MenuItemModel.update(item.id, {
          name: item.name,
          description: item.description,
          price: item.price,
          categoryId: categoryId,
          dietaryTags: item.dietaryTags
        });
      } else {
        // Create new item
        MenuItemModel.create(categoryId, {
          name: item.name,
          description: item.description,
          price: item.price,
          dietaryTags: item.dietaryTags
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Update menu error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
