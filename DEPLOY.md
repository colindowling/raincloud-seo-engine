# RAINCLOUD SEO Engine — Deployment Guide

## DigitalOcean App Platform Setup

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-org/raincloud-seo-engine.git
git push -u origin main
```

### 2. Create DigitalOcean App
- Go to DigitalOcean → Apps → Create App
- Connect your GitHub repo
- Select branch: `main`
- **Plan:** Basic ($5/month — 512MB RAM, 1 vCPU)
- **Build Command:** `npm install`
- **Run Command:** `npm start`
- **HTTP Port:** `3000`
- **Region:** New York (or closest to you)

### 3. Add Block Storage Volume (CRITICAL)
Without this, all project data is lost on every redeploy.

- App Settings → Components → Edit your app component → Storage
- Add Volume: 10GB, mounted at `/data`
- This is the persistent project data store

### 4. Set Environment Variables
App Settings → App-Level Environment Variables

| Variable | Value | Encrypted |
|---|---|---|
| `PORT` | `3000` | No |
| `JWT_SECRET` | Run: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` | **Yes** |
| `HYPERAGENT_API_BASE` | `https://api.hyperagent.com/v1` | No |
| `HYPERAGENT_API_KEY` | Your HyperAgent API key | **Yes** |
| `HYPERAGENT_AGENT_ID` | Your SEO Engine agent ID | **Yes** |
| `APP_BASE_URL` | `https://your-app-name.ondigitalocean.app` | No |
| `DATA_DIR` | `/data/projects` | No |

### 5. Configure HyperAgent

In HyperAgent:
1. Create a new agent named **"SEO Engine Workflows"**
2. Attach the `seo-engine-workflows` skill (confirm the skill draft in Learning → Skills)
3. Add all 8 credential values to the skill
4. Note the agent's ID — set this as `HYPERAGENT_AGENT_ID` in DigitalOcean

The agent's system prompt should be:
```
You are the RAINCLOUD SEO Intelligence Engine workflow runner. When you receive a message starting with WORKFLOW_TRIGGER, parse it and run the appropriate workflow using the seo-engine-workflows skill. Run orchestrator.py with the full message content. Post results back to the callback_url in the message.
```

### 6. Custom Domain (Optional)
- App Settings → Domains → Add Domain
- Add CNAME record pointing to `your-app.ondigitalocean.app`
- DigitalOcean handles SSL automatically

---

## Local Development

```bash
# Install dependencies
npm install

# Create .env
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET

# Run
npm start
# → http://localhost:3000
```

Data is stored in `./data/projects/` locally (configured by DATA_DIR env var).

---

## Architecture Reference

```
Browser
  ↓↑ HTTP (SPA + API)
Node.js / Express (DigitalOcean App Platform)
  └── /data/projects/{slug}/state.json  (Block Storage Volume)
  ↓ POST (workflow trigger)
HyperAgent Executions API
  └── SEO Engine Workflows agent
      └── seo-engine-workflows skill scripts
          ├── DataForSEO (keyword data, SERP, competitor overlap)
          ├── Exa (semantic search, site crawl, subreddit discovery)
          ├── Apify (G2 scraper, Reddit scraper)
          ├── Clay (firmographic enrichment)
          ├── Google APIs (GA4, GSC, Indexing)
          ├── Anthropic Claude (narrative generation, HTML generation)
          └── Notion (calendar push)
  ↓ POST callback → /api/results/:jobId
Node.js (stores result in state.json, updates step_status)
  ↓↑ polling /api/research/:slug/status/:jobId
Browser (updates UI in real-time)
```

---

## Data Model

All project data lives in `/data/projects/{slug}/state.json`. This file is the single source of truth for a project and contains:
- All configuration (brand, identity, lead magnets, contact form)
- GA4/GSC baseline and refreshes
- Full keyword universe with scoring
- Competitor profiles + G2 intelligence
- All page briefs and generated HTML
- 6-month content calendar
- Technical SEO outputs (robots.txt, llms.txt, sitemap.xml)

**Backup:** The DigitalOcean Block Storage Volume is snapshotted automatically. Manual backup: `tar -czf backup.tar.gz /data/projects/`
