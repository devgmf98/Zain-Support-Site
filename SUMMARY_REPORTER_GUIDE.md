# Daily Summary Reporter Guide

## Overview

The Daily Summary Reporter is an automated service that sends periodic email summaries of all status updates made to mobile numbers and SIM cards. It tracks updates by user and status, sending comprehensive reports to configured recipients every 5 minutes.

## Features

✅ **Automatic Reporting**
- Runs every 5 minutes automatically
- Tracks all updates from the current day
- Groups updates by user, status, and type (numbers vs. SIMs)

✅ **Detailed Statistics**
- Shows total mobile numbers updated per user per status
- Shows total SIM cards updated per user per status
- Includes daily summary statistics

✅ **Email Notifications**
- Sends to all configured recipient emails
- Professional HTML-formatted reports
- Includes timestamps and status breakdown

✅ **Database Logging**
- Uses existing `ZAINSUPPORTNUMLOGS` table for mobile numbers
- Uses existing `ZAIN_SUPPORT_SIMS_LOGS` table for SIM cards
- Queries database in real-time for accurate data

## Installation

### 1. File Created
The reporter script has been added to your project:
```
daily-summary-reporter.js
```

### 2. NPM Script Added
The `package.json` has been updated with a new command:
```json
"reporter": "node daily-summary-reporter.js"
```

### 3. Prerequisites
All required packages are already in `package.json`:
- `express`
- `oracledb`
- `dotenv`
- `nodemailer`

No additional installations needed!

## Configuration

### Email Setup
The script uses the same email configuration as the main application. Ensure these environment variables are set in your `.env` file:

```bash
# Database Configuration
DB_USER=CBS_DB_OPSUPP
DB_PASSWORD=CBS_DB_OPSUPP
DB_HOST=172.168.101.238
DB_PORT=1521
DB_SERVICE=PDB1
```

### Recipient Emails
Recipients are automatically fetched from the `RECIPIENT_EMAILS` table in your database. Add email recipients through the web interface:

1. Open the web application (`http://localhost:3000`)
2. Go to **Settings > Email Recipients**
3. Add email addresses where reports should be sent

## Running the Reporter

### Option 1: Run as a Standalone Service
```bash
npm run reporter
```

This starts the reporter as a standalone Node.js process that:
- Connects to the Oracle database
- Sends summary emails every 5 minutes
- Can be stopped with `Ctrl+C`

### Option 2: Run in the Background (Windows)
```powershell
# Start in background
Start-Process -NoNewWindow -FilePath "node" -ArgumentList "daily-summary-reporter.js"
```

### Option 3: Run with PM2 (Recommended for Production)
Install PM2 first:
```bash
npm install -g pm2
```

Start the reporter with PM2:
```bash
pm2 start daily-summary-reporter.js --name "summary-reporter"
```

Useful PM2 commands:
```bash
pm2 status                 # Check status
pm2 logs summary-reporter  # View logs
pm2 stop summary-reporter  # Stop the reporter
pm2 delete summary-reporter # Remove from PM2
```

### Option 4: Run Alongside Main Server
You can modify `server.js` to start the reporter when the main application starts. Add this to the end of `server.js`:

```javascript
// Start daily summary reporter
const { scheduleReporter } = require('./daily-summary-reporter');
scheduleReporter();
```

## Email Report Format

The reporter sends comprehensive emails with:

**Header Section:**
- Title: "Daily Status Update Summary"
- Current date
- Total updates for the day

**Mobile Numbers Section:**
- Table showing:
  - Status value (A, B, F, etc.)
  - User who made the updates
  - Number of mobile numbers updated

**SIM Cards Section:**
- Table showing:
  - Status value (A, B, F, etc.)
  - User who made the updates
  - Number of SIM cards updated

**Example Report:**
```
Mobile Numbers Updates
┌────────┬──────────┬──────────────┐
│ Status │ User     │ Numbers      │
├────────┼──────────┼──────────────┤
│ F      │ admin    │ 10           │
│ F      │ staff    │ 20           │
│ B      │ admin    │ 15           │
│ B      │ staff    │ 5            │
└────────┴──────────┴──────────────┘

SIM Cards Updates
┌────────┬──────────┬──────────────┐
│ Status │ User     │ SIMs         │
├────────┼──────────┼──────────────┤
│ F      │ admin    │ 20           │
│ F      │ staff    │ 30           │
│ B      │ admin    │ 10           │
│ B      │ staff    │ 8            │
└────────┴──────────┴──────────────┘
```

## Logging and Monitoring

### Console Output
The reporter logs all activities to the console:

```
[2024-03-11T10:00:00.000Z] Starting daily summary report...
[2024-03-11T10:00:00.100Z] Sending summary email to user@example.com...
[2024-03-11T10:00:00.500Z] ✓ Summary email sent successfully
[2024-03-11T10:00:05.000Z] Daily summary report completed.
```

### Check Status
To verify the reporter is running:
- Check console logs for timestamp entries
- Look for "Starting daily summary report..." messages every 5 minutes
- Monitor for email sending confirmations

### Troubleshooting

**Issue: No emails being sent**
1. Check that recipient emails are configured in the database
2. Verify email configuration in `.env` file
3. Run the main server first to ensure email settings are valid
4. Check console logs for error messages

**Issue: Database connection errors**
1. Verify Oracle database connection details in `.env`
2. Check network connectivity to the database server
3. Ensure database credentials are correct
4. Confirm `ZAINSUPPORTNUMLOGS` and `ZAIN_SUPPORT_SIMS_LOGS` tables exist

**Issue: Reporter not running continuously**
1. Ensure there are no runtime errors in console
2. Check for process termination messages
3. Use PM2 or a process manager for automatic restart on failure
4. Increase timeout values if database queries are slow

**Issue: Emails are too frequent**
- Modify the `INTERVAL` variable in `daily-summary-reporter.js`:
  ```javascript
  const INTERVAL = 10 * 60 * 1000; // 10 minutes instead of 5
  ```

## Integration with Main Application

### Option A: Standalone Process (Recommended)
Run the reporter as a separate Node.js process:
```bash
# Terminal 1: Start the main application
npm start

# Terminal 2: Start the reporter
npm run reporter
```

### Option B: Integrated with Main Server
Modify `server.js` to include the reporter:

```javascript
// Add this at the end of server.js, after the main server starts listening

// Start daily summary reporter
setTimeout(() => {
  console.log(`[${new Date().toISOString()}] Starting daily summary reporter...`);
  const { scheduleReporter } = require('./daily-summary-reporter');
  scheduleReporter();
}, 2000); // Wait 2 seconds for database pool to initialize
```

## Database Tables Used

### ZAINSUPPORTNUMLOGS
- **Purpose:** Logs all mobile number status updates
- **Columns:** LOG_ID, MOBILE_NUMBER, STATUS_BEFORE, STATUS_AFTER, USERNAME, UPDATE_TIME, CREATED_AT

### ZAIN_SUPPORT_SIMS_LOGS
- **Purpose:** Logs all SIM card status updates
- **Columns:** LOG_ID, SIM_IDENTIFIER, STATUS_BEFORE, STATUS_AFTER, USERNAME, UPDATE_TIME, CREATED_AT

### RECIPIENT_EMAILS
- **Purpose:** Stores email addresses for report recipients
- **Columns:** EMAIL_ID, EMAIL, DESCRIPTION, ADDED_BY, ADDED_AT

## Performance Considerations

- **Database Queries:** Each report execution queries logs from TODAY only
- **Email Sending:** Skipped if no updates recorded in the current day
- **Memory Usage:** Minimal - data is queried fresh every 5 minutes
- **Connection Pool:** Uses Oracle connection pooling (max 10, min 2)

## Scheduling Strategy

The reporter uses a simple interval-based scheduler:
- First run: Immediately on startup
- Subsequent runs: Every 5 minutes (300,000 milliseconds)
- Reports include all updates from the current day

## Security Notes

- Uses the same database credentials as the main application
- Email configuration is read from environment variables
- Database queries filter by date to prevent excessive data loading
- No sensitive data is logged to console (emails masked in some contexts)

## Advanced Customization

### Change Report Interval
Edit `daily-summary-reporter.js`:
```javascript
const INTERVAL = 10 * 60 * 1000; // Change to 10 minutes
```

### Filter by User
Modify the SQL query in `getSummaryData()`:
```javascript
WHERE UPDATE_TIME >= TO_DATE(:startDate, 'YYYY-MM-DD') 
  AND UPDATE_TIME < TO_DATE(:endDate, 'YYYY-MM-DD')
  AND USERNAME = :username  // Add this line
```

### Add More Statuses to Report
The reporter automatically includes all statuses found in logs. No configuration needed!

### Customize Email Template
Edit the `generateEmailHTML()` function to change:
- Colors
- Layout
- Section order
- Additional statistics

## Support and Debugging

### Enable Detailed Logging
Uncomment debug statements in the script for detailed database query logs.

### Test Email Configuration
Use the main application's `/api/test-email` endpoint:
```bash
curl http://localhost:3000/api/test-email
```

### View Database Logs
Query the logging tables directly:
```sql
-- Check today's number updates
SELECT * FROM ZAINSUPPORTNUMLOGS 
WHERE TRUNC(UPDATE_TIME) = TRUNC(SYSDATE)
ORDER BY UPDATE_TIME DESC;

-- Check today's SIM updates
SELECT * FROM ZAIN_SUPPORT_SIMS_LOGS 
WHERE TRUNC(UPDATE_TIME) = TRUNC(SYSDATE)
ORDER BY UPDATE_TIME DESC;
```

## Example Deployment

### Development
```bash
npm run reporter  # Runs in foreground, easy to see logs
```

### Production (With PM2)
```bash
pm2 start daily-summary-reporter.js --name "summary-reporter" --autorestart
pm2 save
pm2 startup
```

### Notes
- The reporter will continue running and sending emails every 5 minutes
- Stop it anytime with `Ctrl+C` or `pm2 stop summary-reporter`
- Logs are persistent and timestamped for monitoring

## Summary

The Daily Summary Reporter provides automated, professional email reports of all status updates made to your system. It's production-ready and requires minimal configuration beyond setting up recipient emails in the web interface.

For questions or issues, check the console logs and ensure:
1. Database connection is working
2. Recipient emails are configured
3. Email SMTP credentials are correct
4. The logging tables contain data from today
