# Railway Deployment Configuration for G-TECH COMPANY

This file configures the application for Railway.app deployment.

## Deployment Steps:

1. **Go to:** https://railway.app

2. **Create Account:**
   - Sign in with GitHub
   - Authorize Railway

3. **Deploy Project:**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose: `moneypay1414/G-tech`
   - Railway will auto-detect Node.js

4. **Configure Environment Variables:**
   - Go to Variables in Railway dashboard
   - Add these variables:
     ```
     DB_USER=CBS_DB_OPSUPP
     DB_PASSWORD=CBS_DB_OPSUPP
     DB_HOST=172.168.101.238
     DB_PORT=1521
     DB_SERVICE=PDB1
     PORT=3000
     NODE_ENV=production
     ```

5. **Deploy:**
   - Railway will automatically deploy
   - Your app will be live at: `https://yourdomain.up.railway.app`

## Important Notes:

- **Database Access:** Ensure your Railway instance can access the Oracle database at `172.168.101.238:1521`
- **Network:** You may need to add Railway's IP to your firewall/security groups
- **Cost:** Free tier includes $5/month credit (usually covers small apps)

## After Deployment:

Your app will be live at a URL like:
```
https://g-tech-production.up.railway.app
```

All users can access the G-TECH COMPANY application from anywhere!

## Troubleshooting:

- Check Railway logs if deployment fails
- Verify database connection with credentials
- Ensure NODE_ENV is set to production

---

For more info: https://docs.railway.app/
