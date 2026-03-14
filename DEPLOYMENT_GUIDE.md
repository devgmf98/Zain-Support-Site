# GitHub Deployment Guide

## Option 1: Using GitHub CLI (Recommended)

### Step 1: Install GitHub CLI
Download from: https://cli.github.com/

Or if you have Chocolatey:
```
choco install gh
```

### Step 2: Authenticate
```
gh auth login
```
- Choose HTTPS
- Paste your GitHub personal access token or let it open your browser to generate one
- Authorize

### Step 3: Deploy
```
cd "C:\Users\Gabriel.Abraham\Desktop\G&M\oracle-status-updater"
git push -u origin main
```

---

## Option 2: Using Personal Access Token

### Step 1: Generate Personal Access Token
1. Go to: https://github.com/settings/tokens
2. Click "Generate new token"
3. Select scopes: `repo` (full control of private repositories)
4. Copy the token

### Step 2: Push with Token
```
cd "C:\Users\Gabriel.Abraham\Desktop\G&M\oracle-status-updater"
git push -u origin main
```
When prompted for password, paste your token (not your GitHub password)

---

## Option 3: Using SSH (Advanced)

### Step 1: Generate SSH Key
```
ssh-keygen -t ed25519 -C "your_email@example.com"
```

### Step 2: Add SSH Key to GitHub
1. Copy your public key: `cat ~/.ssh/id_ed25519.pub`
2. Go to: https://github.com/settings/ssh/new
3. Paste and save

### Step 3: Update Remote URL
```
cd "C:\Users\Gabriel.Abraham\Desktop\G&M\oracle-status-updater"
git remote set-url origin git@github.com:Gabriel-1234/G-tech.git
git push -u origin main
```

---

## Troubleshooting

### Error: "Permission denied"
- Make sure you have write access to the repository
- Check your GitHub credentials
- Use a personal access token instead of password

### Error: "Repository not found"
- Verify the repository name is correct
- Make sure the repository is public or you have access

### Already Deployed?
Check your repository at: https://github.com/Gabriel-1234/G-tech

---

## Verify Deployment
```
git remote -v
git log --oneline
```

Your repository is ready to be pushed!
