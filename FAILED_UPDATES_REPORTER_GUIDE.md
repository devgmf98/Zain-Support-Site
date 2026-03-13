# Failed Updates Reporter Guide

## Overview

The Failed Updates Reporter automatically sends detailed Excel reports of all failed mobile number and SIM card updates every 5 minutes. Each report contains summary statistics grouped by user and failure reason, plus detailed logs with full information.

## Features

✅ **Automated Excel Reports**
- Sends every 5 minutes to configured email recipients
- Separate Excel files for numbers and SIMs
- Professional formatting with summary and detail sheets

✅ **Summary Data**
- Count of failures grouped by **User** and **Failure Reason**
- Quick overview of what went wrong and by whom

✅ **Detailed Logs**
- Complete list of failed mobile numbers/SIMs
- Failure reason for each failed record
- User who attempted the operation
- Timestamp of the failure

✅ **Excel Format**
- Two sheets per file:
  1. **Summary** - Aggregated counts by user and reason
  2. **Details** - Full records with all information

## Database Tables

### ZAIN_SUPPORT_FAILED_NUM_LOGS
Stores details of failed mobile number updates:
- **LOG_ID** - Unique identifier (auto-generated)
- **MOBILE_NUMBER** - The mobile number that failed
- **FAILURE_REASON** - Description of why it failed
- **USERNAME** - User who attempted the update
- **CREATED_AT** - Timestamp of the failure

### ZAIN_SUPPORT_FAILED_SIM_LOGS
Stores details of failed SIM card updates:
- **LOG_ID** - Unique identifier (auto-generated)
- **SIM_IDENTIFIER** - The SIM identifier that failed
- **FAILURE_REASON** - Description of why it failed
- **USERNAME** - User who attempted the update
- **CREATED_AT** - Timestamp of the failure

## How It Works

1. **Every 5 minutes**, the reporter automatically:
   - Queries the failed logs tables for today's failures
   - Groups failures by User and Failure Reason
   - Generates two Excel files (numbers + SIMs)
   - Sends email to all configured recipients

2. **Email includes:**
   - Summary of total failures
   - Two Excel attachments with detailed information

3. **Excel files contain:**
   - Summary sheet with failure counts
   - Details sheet with full failure records

## Logging Failed Updates to the Tables

Your application must log failures when they occur. Here's how to insert failed updates:

### Logging Failed Mobile Numbers

```javascript
const logFailedNumber = async (connection, mobileNumber, failureReason, username) => {
  try {
    const query = `
      INSERT INTO ZAIN_SUPPORT_FAILED_NUM_LOGS 
      (LOG_ID, MOBILE_NUMBER, FAILURE_REASON, USERNAME)
      VALUES (ZAIN_SUPPORT_FAILED_NUM_LOGS_SEQ.NEXTVAL, :mobileNumber, :failureReason, :username)
    `;
    
    await connection.execute(query, {
      mobileNumber,
      failureReason,
      username
    }, { autoCommit: true });
    
    console.log(`Logged failed number: ${mobileNumber} - ${failureReason}`);
  } catch (err) {
    console.error('Error logging failed number:', err.message);
  }
};
```

### Logging Failed SIM Cards

```javascript
const logFailedSim = async (connection, simIdentifier, failureReason, username) => {
  try {
    const query = `
      INSERT INTO ZAIN_SUPPORT_FAILED_SIM_LOGS 
      (LOG_ID, SIM_IDENTIFIER, FAILURE_REASON, USERNAME)
      VALUES (ZAIN_SUPPORT_FAILED_SIM_LOGS_SEQ.NEXTVAL, :simIdentifier, :failureReason, :username)
    `;
    
    await connection.execute(query, {
      simIdentifier,
      failureReason,
      username
    }, { autoCommit: true });
    
    console.log(`Logged failed SIM: ${simIdentifier} - ${failureReason}`);
  } catch (err) {
    console.error('Error logging failed SIM:', err.message);
  }
};
```

### Common Failure Reasons
- "Number already updated today"
- "SIM not found in database"
- "Invalid status value"
- "Restricted number/SIM"
- "Database connection error"
- "Number does not exist"
- "SIM card inactive"
- "User not authorized for this status"

## Example Integration

When updating a status fails, log it:

```javascript
app.post('/api/update-sim-num-status', requireAuth, async (req, res) => {
  const connection = await connectionPool.getConnection();
  
  try {
    const { numbersToUpdate, statusValue } = req.body;
    const username = req.session.user.username;
    
    const results = {
      successful: [],
      failed: [],
      restricted: []
    };

    for (const number of numbersToUpdate) {
      try {
        // Try to update
        const updateQuery = `UPDATE STATUS_V SET CURRENT_STATUS = :status WHERE MOBILE_NUMBER = :number`;
        const updateResult = await connection.execute(updateQuery, {
          status: statusValue,
          number: number
        });

        if (updateResult.rowsAffected > 0) {
          results.successful.push(number);
        } else {
          // Log failure
          await logFailedNumber(connection, number, 'Number not found in database', username);
          results.failed.push(number);
        }
      } catch (err) {
        // Log failure with error reason
        await logFailedNumber(connection, number, err.message, username);
        results.failed.push(number);
      }
    }

    res.json(results);
  } finally {
    await connection.close();
  }
});
```

## Report Format

### Email Subject
```
⚠️ Failed Updates Report - March 11, 2026 (45 numbers, 32 SIMs)
```

### Email Body
Shows:
- 📱 Failed Numbers: **45**
- 💳 Failed SIMs: **32**
- Links to two Excel files with complete details
- Note about the two sheets in each file

### Excel - Summary Sheet (Numbers)

| User  | Failure Reason              | Count |
|-------|---------------------------|-------|
| admin | Number not found          | 10    |
| admin | Restricted number         | 5     |
| staff | Invalid status value      | 15    |
| staff | Database connection error | 15    |

### Excel - Details Sheet (Numbers)

| Mobile Number | Failure Reason            | Created By | Date/Time           |
|---------------|--------------------------|------------|---------------------|
| 923001234567  | Number not found          | admin      | 3/11/2026 10:05:32 |
| 923001234568  | Number not found          | admin      | 3/11/2026 10:05:33 |
| 923001234569  | Restricted number         | admin      | 3/11/2026 10:05:34 |
| ...           | ...                       | ...        | ...                 |

## Configuration

### Enable/Disable Reporter
The reporter runs automatically every 5 minutes. To disable it temporarily, comment out this line in `server.js`:

```javascript
setTimeout(() => {
  startFailedUpdatesReporter();
}, 1500);
```

### Change Report Interval
Edit `server.js` and modify the `INTERVAL` in `startFailedUpdatesReporter()`:

```javascript
const INTERVAL = 10 * 60 * 1000; // Change to 10 minutes
```

### Change Recipients
Recipients are automatically fetched from the `RECIPIENT_EMAILS` table. Add/remove emails through:
1. Web application → Settings → Email Recipients
2. Or insert directly into database:
   ```sql
   INSERT INTO RECIPIENT_EMAILS (EMAIL_ID, EMAIL, DESCRIPTION, ADDED_BY)
   VALUES (RECIPIENT_EMAILS_SEQ.NEXTVAL, 'user@example.com', 'Team lead', 'admin');
   ```

## Monitoring Failures

### View Failed Numbers Today
```sql
SELECT MOBILE_NUMBER, FAILURE_REASON, USERNAME, CREATED_AT
FROM ZAIN_SUPPORT_FAILED_NUM_LOGS
WHERE TRUNC(CREATED_AT) = TRUNC(SYSDATE)
ORDER BY CREATED_AT DESC;
```

### View Failed SIMs Today
```sql
SELECT SIM_IDENTIFIER, FAILURE_REASON, USERNAME, CREATED_AT
FROM ZAIN_SUPPORT_FAILED_SIM_LOGS
WHERE TRUNC(CREATED_AT) = TRUNC(SYSDATE)
ORDER BY CREATED_AT DESC;
```

### Summary by User
```sql
SELECT USERNAME, COUNT(*) as FAILURE_COUNT
FROM ZAIN_SUPPORT_FAILED_NUM_LOGS
WHERE TRUNC(CREATED_AT) = TRUNC(SYSDATE)
GROUP BY USERNAME;
```

### Summary by Failure Reason
```sql
SELECT FAILURE_REASON, COUNT(*) as FAILURE_COUNT
FROM ZAIN_SUPPORT_FAILED_SIM_LOGS
WHERE TRUNC(CREATED_AT) = TRUNC(SYSDATE)
GROUP BY FAILURE_REASON;
```

## Troubleshooting

### Emails Not Being Sent
1. **Check recipient emails:**
   - Verify emails are configured in Settings > Email Recipients
   - Query: `SELECT * FROM RECIPIENT_EMAILS;`

2. **Check for failures:**
   - If no failures exist, email is skipped (avoid spam)
   - Check tables: `SELECT * FROM ZAIN_SUPPORT_FAILED_NUM_LOGS WHERE TRUNC(CREATED_AT) = TRUNC(SYSDATE);`

3. **Email configuration:**
   - Verify Email SMTP credentials in `.env` are correct
   - Check Gmail App Password is valid
   - Ensure 2-Step Verification is enabled on Gmail

### Excel Files Not Generating
1. **Check file permissions:**
   - Temp directory must be writable (usually `/tmp` on Linux, `%TEMP%` on Windows)

2. **Check disk space:**
   - Ensure enough space in temp directory for Excel files

3. **Check console logs:**
   - Look for error messages starting with "Error generating failed"

### Report Never Runs
1. **Verify database tables exist:**
   ```sql
   SELECT table_name FROM user_tables 
   WHERE table_name IN ('ZAIN_SUPPORT_FAILED_NUM_LOGS', 'ZAIN_SUPPORT_FAILED_SIM_LOGS');
   ```

2. **Check server logs:**
   - Look for "Scheduling failed updates reporter" message
   - Check for connection errors

3. **Verify application started:**
   - Run `npm start` and check for errors
   - Ensure database connection is working

## Performance Notes

- **Database Query:** Runs every 5 minutes, queries only today's data
- **File Generation:** Creates two Excel files in-memory
- **Memory Usage:** Minimal - files are temporary and cleaned up
- **Email Sending:** Non-blocking - doesn't wait for completion

## Best Practices

1. **Log meaningful failure reasons:**
   - Helps identify patterns and issues
   - Use consistent reason text for better grouping

2. **Review reports regularly:**
   - High failure rates indicate system issues
   - Investigate common failure reasons

3. **Maintain recipient list:**
   - Keep email list current
   - Add new team members as needed

4. **Archive reports:**
   - Keep Excel files for audit trail
   - Consider automated archival for long-term storage

## Integration Examples

### Restrict Valid Statuses
```javascript
const VALID_STATUSES = ['A', 'B', 'F'];

if (!VALID_STATUSES.includes(statusValue)) {
  await logFailedNumber(connection, number, 
    `Invalid status: ${statusValue}`, username);
  return;
}
```

### Check Restricted Numbers
```javascript
if (matchesPrefix(number, restrictedNumbersCache)) {
  await logFailedNumber(connection, number, 
    'Restricted number - cannot update', username);
  return;
}
```

### Database Error Handling
```javascript
try {
  await connection.execute(updateQuery, {/* ... */});
} catch (err) {
  // Log with specific error from database
  const errorMsg = err.message || 'Unknown database error';
  await logFailedNumber(connection, number, errorMsg, username);
}
```

## Summary

The Failed Updates Reporter provides automated 5-minute reports of all failures with:
- ✅ Professional Excel files for easy analysis
- ✅ Summary statistics grouped by user and reason
- ✅ Detailed logs with full failure information
- ✅ Automatic email delivery to configured recipients
- ✅ Easy integration with your update operations

Simply log failures when they occur and let the reporter handle the rest!
