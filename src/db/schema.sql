-- Core restaurant info
CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY,
  name TEXT,
  tagline TEXT,
  description TEXT,
  cuisine_type TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  website_url TEXT,
  hours_json TEXT, -- JSON: {"mon": "9am-10pm", ...}
  primary_image_path TEXT,
  logo_path TEXT,
  style_theme TEXT DEFAULT 'modern', -- 'modern', 'rustic', 'vibrant'
  primary_color TEXT DEFAULT '#2563eb',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Menu structure
CREATE TABLE IF NOT EXISTS menu_categories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price REAL,
  image_path TEXT,
  is_featured INTEGER DEFAULT 0,
  dietary_tags_json TEXT, -- JSON array: ["vegetarian", "gluten-free"]
  display_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES menu_categories(id) ON DELETE CASCADE
);

-- Photo gallery
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  path TEXT NOT NULL,
  caption TEXT,
  type TEXT DEFAULT 'food', -- 'food', 'interior', 'exterior', 'menu'
  is_primary INTEGER DEFAULT 0,
  display_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

-- Generated materials tracking
CREATE TABLE IF NOT EXISTS generated_materials (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  type TEXT NOT NULL, -- 'website', 'brochure_pdf', 'brochure_image'
  file_path TEXT,
  cloudflare_url TEXT,
  version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

-- Processing jobs
CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT,
  video_path TEXT,
  status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
  progress INTEGER DEFAULT 0,
  error_message TEXT,
  missing_fields_json TEXT, -- JSON array of missing required fields
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Notes (announcements, special info, etc.)
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  content TEXT NOT NULL,
  expires_at TEXT, -- ISO date, NULL = never expires
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_restaurant ON notes(restaurant_id);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_menu_categories_restaurant ON menu_categories(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_photos_restaurant ON photos(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_materials_restaurant ON generated_materials(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_jobs_restaurant ON processing_jobs(restaurant_id);

-- Shorts processing jobs
CREATE TABLE IF NOT EXISTS shorts_jobs (
  id TEXT PRIMARY KEY,
  video_path TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'ready', 'uploaded', 'failed'
  progress INTEGER DEFAULT 0,
  progress_stage TEXT, -- 'analyzing', 'clip_extracted', 'script_ready', 'voiceover_done', 'audio_mixed', 'ready'
  error_message TEXT,

  -- Clip selection results
  clip_start REAL, -- Start time in seconds
  clip_end REAL, -- End time in seconds
  clip_path TEXT, -- Extracted clip path

  -- Voiceover results
  script TEXT, -- Generated voiceover script
  voiceover_path TEXT, -- Generated audio path

  -- Final output
  output_path TEXT, -- Final shorts-format video (narrated version)
  output_path_asmr TEXT, -- ASMR version (cooking sounds only, no voiceover)
  thumbnail_path TEXT,

  -- YouTube metadata
  title TEXT,
  description TEXT,
  tags_json TEXT, -- JSON array of tags
  youtube_video_id TEXT, -- After upload
  youtube_url TEXT,

  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shorts_jobs_status ON shorts_jobs(status);

-- Orders for online ordering
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  customer_email TEXT,
  customer_name TEXT,
  items_json TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON orders(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Reviews aggregated from external platforms
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  source TEXT NOT NULL, -- 'google', 'yelp'
  external_id TEXT, -- ID from source platform for deduplication
  author_name TEXT,
  author_url TEXT,
  rating REAL, -- 1-5 scale normalized
  text TEXT,
  review_date TEXT, -- ISO date from source
  sentiment_score REAL, -- -1.0 to 1.0
  sentiment_label TEXT, -- 'positive', 'negative', 'neutral', 'mixed'
  key_themes_json TEXT, -- JSON array of detected themes
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
  UNIQUE(restaurant_id, source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_restaurant ON reviews(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_reviews_source ON reviews(source);
CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(review_date);
CREATE INDEX IF NOT EXISTS idx_reviews_sentiment ON reviews(sentiment_label);

-- Weekly digest summaries generated by AI
CREATE TABLE IF NOT EXISTS review_digests (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  period_start TEXT NOT NULL, -- ISO date
  period_end TEXT NOT NULL, -- ISO date
  review_count INTEGER DEFAULT 0,
  avg_rating REAL,
  summary TEXT, -- AI-generated sentiment summary
  complaints_json TEXT, -- JSON array of {theme, severity, examples}
  praise_json TEXT, -- JSON array of {theme, count, examples}
  actions_json TEXT, -- JSON array of {action, priority, reason}
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digests_restaurant ON review_digests(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_digests_period ON review_digests(period_start, period_end);

-- Platform connections for fetching reviews
CREATE TABLE IF NOT EXISTS review_platform_tokens (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL UNIQUE,
  google_place_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_platform_tokens_restaurant ON review_platform_tokens(restaurant_id);

-- Digest preferences per restaurant
CREATE TABLE IF NOT EXISTS digest_preferences (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL UNIQUE,
  email_enabled INTEGER DEFAULT 0,
  email_address TEXT,
  frequency TEXT DEFAULT 'weekly', -- 'daily', 'weekly', 'monthly'
  day_of_week INTEGER DEFAULT 1, -- 0=Sun, 1=Mon, etc.
  hour_of_day INTEGER DEFAULT 9, -- 0-23
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digest_prefs_restaurant ON digest_preferences(restaurant_id);
