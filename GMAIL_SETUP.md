# Gmail Setup for Email Notifications

## Issue: "Username and Password not accepted"

Gmail does NOT allow third-party applications to use your regular Gmail password for security reasons. You need to create a special **App Password** instead.

## Step-by-Step Setup

### 1. Enable 2-Step Verification (if not already enabled)
- Go to [https://myaccount.google.com/security](https://myaccount.google.com/security)
- On the left menu, click **Security**
- Scroll down to "How you sign in to Google"
- Click **2-Step Verification**
- Follow the prompts to enable it

### 2. Generate an App Password
- Go to [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
- If the link doesn't work, you can also:
  - Go to [https://myaccount.google.com/security](https://myaccount.google.com/security)
  - Scroll down to "Your devices"
  - Click **Manage all devices**
  - Click your device
  - Click **App passwords** at the bottom

- Select:
  - **App**: Mail
  - **Device**: Windows Computer (or your device)

- Google will generate a 16-character password (without spaces)
- **Copy this password exactly as shown** (it will be something like: `abcd efgh ijkl mnop` but without spaces)

### 3. Update .env File
Replace the `EMAIL_PASSWORD` in your `.env` file with the 16-character App Password:

```env
EMAIL_USER=gabrielgmf988@gmail.com
EMAIL_PASSWORD=<your-16-character-app-password>
```

**Example:**
```env
EMAIL_PASSWORD=abcdefghijklmnop
```

### 4. Restart the Server
After updating `.env`, restart the server:
```bash
npm start
```

### 5. Test Email Configuration
Once the server is running, test the email configuration:
```bash
curl http://localhost:3000/api/test-email
```

You should see:
```json
{
  "status": "success",
  "message": "Email configuration is valid",
  "emailConfig": {...}
}
```

## Alternative: Enable "Less Secure App Access"

If you can't use App Passwords (not available in your Google account):
1. Go to [https://myaccount.google.com/lesssecureapps](https://myaccount.google.com/lesssecureapps)
2. Enable "Less secure app access"
3. Use your regular Gmail password in `.env`

**Note:** This method is less secure and Google may disable it.

## Troubleshooting

### Still getting "Invalid login" error?
- Make sure you copied the 16-character app password **exactly**
- Don't include spaces in the password
- The email password field should have NO spaces
- Restart the server after changing `.env`
- Clear your .env cache: Delete `node_modules/.cache` if it exists

### Not receiving emails?
Check the server logs when making an update:
```bash
curl -X POST http://localhost:3000/api/update-sims-status \
  -H "Content-Type: application/json" \
  -d '{"simIdentifier":"SIM1","statusValue":"P"}'
```

Look for email logs showing:
- `[timestamp] Sending email to BSS_OPS@ss.zain.com...`
- `[timestamp] Email sent successfully...`

## Testing Email Manually

Once configured, test by sending a SIM update:

```bash
curl -X POST http://localhost:3000/api/update-sims-status \
  -H "Content-Type: application/json" \
  -d '{
    "simIdentifier": "TEST-SIM-001",
    "statusValue": "P"
  }'
```

If it works, you'll see in the logs:
```
[timestamp] Sending email to BSS_OPS@ss.zain.com...
[timestamp] Email sent successfully to BSS_OPS@ss.zain.com:
```

And an email will be received at `BSS_OPS@ss.zain.com`
