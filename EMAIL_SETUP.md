# Email Notification Feature

## Overview
The SIM Status Updater now includes automatic email notifications that are sent to `BSS_OPS@ss.zain.com` whenever SIM statuses are successfully updated.

## Configuration

### Email Setup

You'll need to configure your email credentials in the `.env` file:

```
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=your-email@gmail.com
```

### Email Provider Configuration

#### Gmail
1. Enable "Less secure app access" or use an [App Password](https://support.google.com/accounts/answer/185833)
2. Use the following settings:
   - `EMAIL_HOST`: `smtp.gmail.com`
   - `EMAIL_PORT`: `587`
   - `EMAIL_SECURE`: `false`
   - `EMAIL_USER`: Your Gmail address
   - `EMAIL_PASSWORD`: Your Gmail password or App Password

#### Office 365
```
EMAIL_HOST=smtp.office365.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@company.com
EMAIL_PASSWORD=your-password
```

#### Custom SMTP Server
```
EMAIL_HOST=your-smtp-server.com
EMAIL_PORT=587 (or 465 for secure)
EMAIL_SECURE=false (or true for port 465)
EMAIL_USER=username
EMAIL_PASSWORD=password
```

## Features

### Automatic Email Notifications
Emails are automatically sent when:
- SIM identifiers are updated via `/api/update-sims-status`
- SIM numbers are updated via `/api/update-sim-num-status`
- Bulk mobile numbers are updated via `/api/bulk-update-status`

### Email Contents
Each email includes:
- Timestamp of the operation
- Total number of SIMs/mobiles processed
- Number of successfully updated records
- New status value applied
- Number of restricted updates (skipped)
- Number of failed updates
- List of failed identifiers (if any)
- List of successfully updated SIMs/mobiles

## Testing Email Configuration

To test your email configuration, you can use the health check endpoint which will also verify email connectivity:

```bash
curl http://localhost:3000/api/health
```

## Troubleshooting

### Emails Not Sending
1. **Check credentials**: Verify EMAIL_USER and EMAIL_PASSWORD are correct
2. **Firewall/Network**: Ensure outbound SMTP connections are allowed on the configured port
3. **Check logs**: Look at server console for error messages containing "Error sending email"
4. **App Passwords**: If using Gmail, make sure you're using an App Password, not your regular password

### Common Issues

**EAUTH Authentication Error**
- Verify your EMAIL_USER and EMAIL_PASSWORD are correct
- For Gmail, use an App Password instead of your regular password

**ECONNREFUSED**
- Check that EMAIL_HOST and EMAIL_PORT are correct
- Verify firewall allows outbound connections on that port

**Timeout**
- Increase EMAIL_PORT timeout if behind a slow connection
- Check network connectivity to the SMTP server

## API Endpoints with Email Notifications

### 1. Update SIM Status by Identifier
```bash
POST /api/update-sims-status
Content-Type: application/json

{
  "simIdentifier": "SIM1, SIM2, SIM3",
  "statusValue": "P"
}
```

### 2. Update SIM Status by SIM Number
```bash
POST /api/update-sim-num-status
Content-Type: application/json

{
  "simNum": "8901260123456789 8901260123456790",
  "statusValue": "P"
}
```

### 3. Bulk Update Mobile Status
```bash
POST /api/bulk-update-status
Content-Type: application/json

{
  "mobileNumbers": ["923001234567", "923009876543"],
  "statusValue": "P"
}
```

All three endpoints will automatically send an email notification to `BSS_OPS@ss.zain.com` if at least one record is successfully updated.

## Email Recipient Customization

To change the default recipient, you can:
1. Add `RECIPIENT_EMAIL` to your `.env` file
2. Or modify the `sendEmailNotification()` function in `server.js` to use a different default

## Security Notes

- Never commit your `.env` file with real credentials to version control
- Use environment variables for all sensitive information
- Consider using email service accounts rather than personal accounts
- Rotate passwords/app passwords regularly
