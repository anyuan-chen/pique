import { Router } from 'express';
import multer from 'multer';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { VideoExtractor } from '../services/video-extractor.js';
import { RestaurantModel, MenuCategoryModel, MenuItemModel, PhotoModel, JobModel } from '../db/models/index.js';
import { promises as fs } from 'fs';

const router = Router();

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.paths.uploads);
  },
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop();
    cb(null, `${uuidv4()}.${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4, MOV, and WebM are allowed.'));
    }
  }
});

// Upload video without processing (for shorts, etc.)
router.post('/video/raw', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    // Just return the path - no processing
    const videoUrl = `/uploads/${req.file.filename}`;
    res.json({ videoUrl, filename: req.file.filename });
  } catch (error) {
    console.error('Raw upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload video and start processing
router.post('/video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const videoPath = req.file.path;
    const existingRestaurantId = req.body.restaurantId || null;

    // Create a processing job
    const job = JobModel.create({ videoPath });

    // If updating existing restaurant, set it on the job now
    if (existingRestaurantId) {
      JobModel.setRestaurantId(job.id, existingRestaurantId);
    }

    // Start processing in background
    processVideo(job.id, videoPath, existingRestaurantId).catch(err => {
      console.error('Video processing error:', err);
      JobModel.setError(job.id, err.message);
    });

    res.json({
      jobId: job.id,
      restaurantId: existingRestaurantId,
      message: 'Video uploaded successfully. Processing started.',
      status: 'processing'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get processing status
router.get('/status/:jobId', (req, res) => {
  const job = JobModel.getById(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    restaurantId: job.restaurant_id,
    missingFields: job.missingFields,
    error: job.error_message
  });
});

// Background video processing function
async function processVideo(jobId, videoPath, existingRestaurantId = null) {
  const extractor = new VideoExtractor();

  try {
    // Update status
    JobModel.updateStatus(jobId, 'processing', 10);

    // Use native video understanding with fallback
    console.log('Analyzing video with native Gemini understanding...');
    const outputDir = join(config.paths.images, jobId);
    const result = await extractor.extractWithFallback(videoPath, { outputDir });

    JobModel.updateProgress(jobId, 60);

    const { frames, menuItems, restaurantInfo, style } = result;

    let restaurant;
    if (existingRestaurantId) {
      // Update existing restaurant - only set extracted fields that don't overwrite Google Places data
      restaurant = RestaurantModel.update(existingRestaurantId, {
        tagline: restaurantInfo.tagline,
        description: restaurantInfo.description,
        cuisineType: restaurantInfo.cuisineType,
        styleTheme: style.theme || 'modern',
        primaryColor: style.primaryColor || '#2563eb'
      });
      // Job already has restaurantId set
    } else {
      // Create new restaurant record
      restaurant = RestaurantModel.create({
        name: restaurantInfo.name,
        tagline: restaurantInfo.tagline,
        description: restaurantInfo.description,
        cuisineType: restaurantInfo.cuisineType,
        styleTheme: style.theme || 'modern',
        primaryColor: style.primaryColor || '#2563eb'
      });
      JobModel.setRestaurantId(jobId, restaurant.id);
    }

    JobModel.updateProgress(jobId, 70);

    // Create menu categories and items
    if (menuItems.items && menuItems.items.length > 0) {
      const categoriesMap = new Map();

      for (const item of menuItems.items) {
        const categoryName = item.category || 'Main Dishes';

        if (!categoriesMap.has(categoryName)) {
          const category = MenuCategoryModel.create(restaurant.id, { name: categoryName });
          categoriesMap.set(categoryName, category.id);
        }

        MenuItemModel.create(categoriesMap.get(categoryName), {
          name: item.name,
          description: item.description,
          price: item.price,
          dietaryTags: item.dietaryTags || []
        });
      }
    }

    JobModel.updateProgress(jobId, 80);

    // Save photo references from extracted frames
    if (frames && frames.length > 0) {
      for (const frame of frames) {
        PhotoModel.create(restaurant.id, {
          path: frame.path,
          type: frame.type,
          caption: frame.description,
          isPrimary: frame.type === 'exterior' || frame.type === 'interior'
        });
      }
    }

    JobModel.updateProgress(jobId, 90);

    // Identify missing fields
    const missingFields = [];
    if (!restaurantInfo.name) missingFields.push('name');
    if (!menuItems.items || menuItems.items.length === 0) missingFields.push('menu');
    if (menuItems.items?.some(item => item.needsReview)) {
      missingFields.push('menu_review');
    }

    JobModel.setMissingFields(jobId, missingFields);

    // Complete the job
    JobModel.complete(jobId);

    console.log(`Video processing complete for restaurant: ${restaurant.id}`);

  } catch (error) {
    console.error('Processing error:', error);
    JobModel.setError(jobId, error.message);
    throw error;
  }
}

export default router;
