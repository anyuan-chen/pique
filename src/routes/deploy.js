import { Router } from 'express';
import { WebsiteGenerator } from '../services/website-generator.js';
import { IterativeWebsiteGenerator } from '../services/iterative-generator.js';
import { BrochureGenerator } from '../services/brochure-generator.js';
import { CloudflareDeployer } from '../services/cloudflare-deploy.js';
import { RestaurantModel, MaterialModel, WebsiteJobModel } from '../db/models/index.js';

const router = Router();

const brochureGenerator = new BrochureGenerator();
const cloudflareDeployer = new CloudflareDeployer();

/**
 * Process website generation and deployment in the background
 */
async function processWebsite(jobId) {
  const job = WebsiteJobModel.getById(jobId);
  if (!job) {
    throw new Error('Job not found');
  }

  WebsiteJobModel.updateStatus(jobId, 'processing');

  try {
    // 10% - Starting
    WebsiteJobModel.updateProgress(jobId, 10, 'starting');

    // Create the appropriate generator
    const generator = job.useIterative
      ? new IterativeWebsiteGenerator()
      : new WebsiteGenerator();

    // Progress callback to update job (scale to 0-80% for generation)
    // Wrapped in try-catch to prevent callback errors from crashing generation
    const onProgress = (progress, stage) => {
      try {
        // Scale progress: generation is 0-80%, deployment is 80-100%
        const scaledProgress = Math.round(progress * 0.8);
        WebsiteJobModel.updateProgress(jobId, scaledProgress, stage);
      } catch (err) {
        console.error('Progress update failed:', err.message);
      }
    };

    // Generate website with progress callbacks
    const result = await generator.generate(job.restaurantId, { onProgress });

    // 85% - Deploying to Cloudflare
    WebsiteJobModel.updateProgress(jobId, 85, 'deploying');

    // Deploy to Cloudflare
    let deployedUrl = null;
    try {
      const deployResult = await cloudflareDeployer.deploy(job.restaurantId);
      deployedUrl = deployResult.url;
    } catch (deployError) {
      console.error('Cloudflare deployment failed:', deployError.message);
      // Continue without deployment - website is still generated locally
      // User can manually deploy later
    }

    // 100% - Complete
    WebsiteJobModel.complete(
      jobId,
      result.materialId,
      result.path,
      deployedUrl,
      result.iterations || null
    );

    return { ...result, deployedUrl };

  } catch (error) {
    WebsiteJobModel.setError(jobId, error.message);
    throw error;
  }
}

// Generate website (async - returns jobId immediately)
router.post('/generate/website/:id', async (req, res) => {
  try {
    const restaurant = RestaurantModel.getById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Check for existing pending/processing job to prevent concurrent generation
    const existingJob = WebsiteJobModel.getPending(req.params.id);
    if (existingJob) {
      return res.status(409).json({
        error: 'Website generation already in progress',
        jobId: existingJob.id,
        status: existingJob.status,
        progress: existingJob.progress
      });
    }

    const { iterative = false } = req.body || {};

    // Create job immediately
    const job = WebsiteJobModel.create(req.params.id, { useIterative: iterative });

    // Start async processing (fire-and-forget)
    processWebsite(job.id).catch(err => {
      console.error('Website generation error:', err);
      // Error is already saved to job by processWebsite
    });

    // Return immediately
    res.json({
      jobId: job.id,
      status: 'pending',
      message: 'Website generation started'
    });
  } catch (error) {
    console.error('Website generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get website generation job status
router.get('/generate/website/status/:jobId', (req, res) => {
  try {
    const job = WebsiteJobModel.getById(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  } catch (error) {
    console.error('Job status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get the latest deployed URL for a restaurant
router.get('/generate/website/url/:restaurantId', (req, res) => {
  try {
    const restaurantId = req.params.restaurantId;

    // Build the preview-static URL (same-origin, works through tunnel with experiments)
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const previewUrl = `${protocol}://${host}/preview-static/${restaurantId}/`;

    // Also get CF URL if available
    let cfUrl = null;
    const material = MaterialModel.getLatestByType(restaurantId, 'website');
    if (material?.cloudflare_url) {
      cfUrl = material.cloudflare_url;
    } else {
      const jobs = WebsiteJobModel.getByRestaurant(restaurantId);
      const deployed = jobs.find(j => j.deployedUrl);
      if (deployed) cfUrl = deployed.deployedUrl;
    }

    res.json({ deployedUrl: previewUrl, cfUrl });
  } catch (error) {
    console.error('Get URL error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check for pending website generation job (for page reload recovery)
router.get('/generate/website/pending/:restaurantId', (req, res) => {
  try {
    const job = WebsiteJobModel.getPending(req.params.restaurantId);
    if (job) {
      res.json({ jobId: job.id, status: job.status, progress: job.progress });
    } else {
      res.json({});
    }
  } catch (error) {
    console.error('Pending job check error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate brochure
router.post('/generate/brochure/:id', async (req, res) => {
  try {
    const restaurant = RestaurantModel.getById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const { layout = 'portrait' } = req.body;
    const result = await brochureGenerator.generate(req.params.id, { layout });

    res.json({
      success: true,
      message: `Brochure generated in ${layout} layout`,
      pdfPath: result.pdfPath,
      imagePath: result.imagePath,
      downloadUrl: `/api/download/pdf/${req.params.id}`,
      previewUrl: `/api/download/image/${req.params.id}`
    });
  } catch (error) {
    console.error('Brochure generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate all materials
router.post('/generate/all/:id', async (req, res) => {
  try {
    const restaurant = RestaurantModel.getById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const results = {};

    // Generate website (synchronously for /generate/all)
    try {
      const websiteGenerator = new WebsiteGenerator();
      results.website = await websiteGenerator.generate(req.params.id);
    } catch (error) {
      results.website = { error: error.message };
    }

    // Generate brochures
    try {
      results.brochurePortrait = await brochureGenerator.generate(req.params.id, { layout: 'portrait' });
    } catch (error) {
      results.brochurePortrait = { error: error.message };
    }

    try {
      results.brochureLandscape = await brochureGenerator.generate(req.params.id, { layout: 'landscape' });
    } catch (error) {
      results.brochureLandscape = { error: error.message };
    }

    res.json({
      success: true,
      message: 'All materials generated',
      results
    });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Deploy to Cloudflare
router.post('/cloudflare/:id', async (req, res) => {
  try {
    const restaurant = RestaurantModel.getById(req.params.id);
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Check if website exists
    const material = MaterialModel.getLatestByType(req.params.id, 'website');
    if (!material) {
      return res.status(400).json({ error: 'Website not generated yet. Generate website first.' });
    }

    const result = await cloudflareDeployer.deploy(req.params.id);

    res.json({
      success: true,
      message: 'Website deployed to Cloudflare Pages',
      url: result.url,
      projectName: result.projectName
    });
  } catch (error) {
    console.error('Deployment error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
