/**
 * Shared mock data and helpers for onboarding e2e tests
 */

export const mockSearchResults = {
  predictions: [
    {
      placeId: 'place-123',
      name: 'Test Restaurant',
      address: '123 Main St, San Francisco, CA'
    },
    {
      placeId: 'place-456',
      name: 'Another Restaurant',
      address: '456 Oak Ave, San Francisco, CA'
    }
  ]
};

export const scenarios = {
  newRestaurant: {
    checkResponse: {
      exists: false,
      hasData: false,
      placeData: {
        name: 'Test Restaurant',
        address: '123 Main St, San Francisco, CA',
        phone: '(555) 123-4567'
      }
    },
    restaurantId: 'new-123',
    menuItems: [
      { id: 'item-1', name: 'Truffle Pasta', description: 'Fresh pasta with truffle', category: 'Mains', price: 24, needsReview: false },
      { id: 'item-2', name: 'House Salad', description: 'Mixed greens', category: 'Appetizers', price: 12, needsReview: true },
      { id: 'item-3', name: 'Tiramisu', description: 'Classic Italian dessert', category: 'Desserts', price: 10, needsReview: false }
    ]
  },

  existingWithoutData: {
    checkResponse: {
      exists: true,
      restaurantId: 'existing-789',
      hasData: false
    },
    restaurantId: 'existing-789',
    menuItems: [
      { id: 'item-1', name: 'Burger', description: 'Juicy beef burger', category: 'Mains', price: 15, needsReview: false },
      { id: 'item-2', name: 'Fries', description: 'Crispy fries', category: 'Sides', price: 5, needsReview: true }
    ]
  },

  existingWithData: {
    checkResponse: {
      exists: true,
      restaurantId: 'existing-789',
      hasData: true
    },
    restaurantId: 'existing-789',
    menuItems: []
  }
};

/**
 * Set up all API mocks for a given scenario
 */
export async function mockOnboardingAPIs(page, scenario) {
  // Mock search - always returns test results
  await page.route('**/api/onboard/search*', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockSearchResults)
    });
  });

  // Mock check with scenario-specific response
  await page.route('**/api/onboard/check', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(scenario.checkResponse)
    });
  });

  // Mock create (only called for new restaurants)
  await page.route('**/api/onboard/create', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ restaurantId: scenario.restaurantId })
    });
  });

  // Mock video upload
  await page.route('**/api/upload/video', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId: 'job-456',
        restaurantId: scenario.restaurantId
      })
    });
  });

  // Mock status polling with progress simulation
  let pollCount = 0;
  await page.route('**/api/upload/status/*', route => {
    pollCount++;
    const progress = Math.min(pollCount * 25, 100);
    const status = progress >= 100 ? 'completed' : 'processing';
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status,
        progress,
        restaurantId: scenario.restaurantId,
        missingFields: status === 'completed' && scenario.menuItems?.some(m => m.needsReview) ? ['menu_review'] : []
      })
    });
  });

  // Mock get menu items for confirmation
  await page.route('**/api/onboard/menu/*', route => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ menuItems: scenario.menuItems || [] })
      });
    } else if (route.request().method() === 'PUT') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true })
      });
    }
  });
}

/**
 * Create a fake video file for upload testing
 */
export function createFakeVideoFile() {
  return {
    name: 'test-video.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('fake video content')
  };
}
