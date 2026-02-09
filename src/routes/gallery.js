import { Router } from 'express';
import { MaterialModel, WebsiteJobModel, ShortsJobModel } from '../db/models/index.js';

const router = Router();

/**
 * GET /:restaurantId — return all generated assets for the gallery
 */
router.get('/:restaurantId', (req, res) => {
  const { restaurantId } = req.params;

  try {
    // Graphics: all materials of type 'graphic'
    const allMaterials = MaterialModel.getByRestaurant(restaurantId);
    const graphics = allMaterials
      .filter(m => m.type === 'graphic')
      .map(m => ({
        id: m.id,
        url: m.file_path ? `/images/${m.file_path.split('/').pop()}` : null,
        createdAt: m.created_at
      }));

    // Websites: completed website jobs for this restaurant
    const allWebsiteJobs = WebsiteJobModel.getByRestaurant(restaurantId);
    const websites = allWebsiteJobs
      .filter(j => j.status === 'ready')
      .map(j => ({
        id: j.id,
        deployedUrl: j.deployedUrl,
        previewUrl: `/api/website/${restaurantId}`,
        createdAt: j.createdAt
      }));

    // Shorts: recent completed shorts — one entry per variant
    const allShorts = ShortsJobModel.getRecent(20);
    const shorts = [];
    for (const s of allShorts) {
      if (s.status !== 'ready' && s.status !== 'uploaded') continue;
      for (const v of s.variants) {
        const suffix = v.type === 'narrated' ? '' : ` (${v.type.toUpperCase()})`;
        shorts.push({
          id: v.type === 'narrated' ? s.id : `${s.id}-${v.type}`,
          title: `${s.title || 'Short'}${suffix}`,
          variant: v.type,
          thumbnailUrl: s.thumbnailPath ? `/api/shorts/thumbnail/${s.id}` : null,
          youtubeUrl: v.youtubeUrl,
          previewUrl: `/api/shorts/preview/${s.id}/${v.type}`,
          createdAt: s.createdAt
        });
      }
    }

    res.json({ graphics, websites, shorts });
  } catch (err) {
    console.error('Gallery fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
