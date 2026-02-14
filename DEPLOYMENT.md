# 🚀 Deployment Guide - Patient Portal Fix

## Overview

This guide walks you through deploying the enhanced backend that fixes the patient portal access issue.

## ⚠️ Before You Deploy

### 1. Understand Your Current Data

Based on your MongoDB screenshots, your data looks like:

**Prescriptions:**
```javascript
{
  _id: ObjectId("69897588de9fcfc18bal2233"),
  patientId: "E9MdQVDP6JJe8Y2GqXAV",  // This is the patient chart ID
  prescribedByUid: "rbwfNnPlQkBpRznMObsTdzT9ujb2",
  medication: "Lisinopril",
  // ...
}
```

**Lab Requests:**
```javascript
{
  _id: ObjectId("698a8fe165be38a2b453a344"),
  patientId: "E9MdQVDP6JJe8Y2GqXAV",  // Same patient chart ID
  doctorId: "rbwfNnPlQkBpRznMObsTdzT9ujb2",
  tests: "FBC",
  // ...
}
```

**Key Observation:** Your data uses Firestore document IDs (like `E9MdQVDP6JJe8Y2GqXAV`) as the `patientId`, not Firebase Auth UIDs.

### 2. Identify the Problem

When patients log in:
1. They authenticate with Firebase Auth → get UID (e.g., `abc123`)
2. Patient portal uses this UID to request data
3. Backend queries MongoDB for `patientId: "abc123"`
4. But prescriptions have `patientId: "E9MdQVDP6JJe8Y2GqXAV"`
5. **No match found** → Empty list returned

### 3. How This Fix Works

The enhanced backend:
1. Receives request with UID `abc123`
2. Checks Firestore for patient chart with `userId: "abc123"`
3. Finds chart document ID: `E9MdQVDP6JJe8Y2GqXAV`
4. Queries MongoDB for **both** IDs
5. **Data found!** → Returns prescriptions and labs

## 📋 Pre-Deployment Checklist

- [ ] Backup current Render deployment configuration
- [ ] Backup MongoDB data (optional but recommended)
- [ ] Have Firebase service account key ready
- [ ] Verify MongoDB connection string
- [ ] Test locally first (recommended)

## 🔧 Local Testing (Recommended)

### Step 1: Setup Environment

```bash
cd backend_render_enhanced

# Create .env file
cp .env.example .env

# Edit .env with your credentials
nano .env  # or use your preferred editor
```

Add your actual values:
```env
MONGODB_URI=mongodb+srv://...  # Your actual MongoDB connection string
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}  # Your actual service account
DEBUG_PATIENT_IDS=true  # Enable debugging
```

### Step 2: Install and Run

```bash
# Install dependencies
npm install

# Start the server
npm start
```

You should see:
```
API running on port 3000
```

### Step 3: Test the Fix

Get a Firebase ID token for a patient user, then:

```bash
# Replace YOUR_TOKEN and PATIENT_UID with actual values
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/patients/PATIENT_UID/prescriptions

# You should see prescriptions now!
```

Check the server logs for debug output:
```
[PATIENT_ID_RESOLVER] Input: {...}
[PATIENT_ID_RESOLVER] Resolved IDs: [...]
[PRESCRIPTIONS] Resolved patient IDs: [...]
```

### Step 4: Verify All Data Types

```bash
# Test prescriptions
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/patients/PATIENT_UID/prescriptions

# Test lab requests
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3000/patients/PATIENT_UID/lab_requests

# Test health endpoint
curl http://localhost:3000/health/detailed
```

## 🚀 Deploy to Render

### Option A: GitHub Deployment (Recommended)

#### Step 1: Commit to Git

```bash
cd backend_render_enhanced

# Initialize git (if not already)
git init

# Add all files
git add .

# Commit
git commit -m "Deploy enhanced backend v2.0.0 - Fix patient portal access"

# Push to GitHub
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

#### Step 2: Configure Render

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name:** `homecare-backend-v2` (or your preferred name)
   - **Branch:** `main`
   - **Root Directory:** Leave empty (or `backend_render_enhanced` if this is a subdirectory)
   - **Build Command:** Leave empty
   - **Start Command:** `npm start`
   - **Instance Type:** Free or Starter (depending on your needs)

#### Step 3: Add Environment Variables

In Render dashboard, add these environment variables:

```
MONGODB_URI = mongodb+srv://...
FIREBASE_SERVICE_ACCOUNT = {"type":"service_account",...}
NODE_ENV = production
```

**Optional:**
```
ALLOWED_ORIGINS = https://your-flutter-app.com
DEBUG_PATIENT_IDS = false
```

#### Step 4: Deploy

Click "Create Web Service"

Render will:
1. Clone your repo
2. Run `npm install`
3. Start with `npm start`
4. Give you a URL like `https://homecare-backend-v2.onrender.com`

### Option B: Manual Deploy (Not Recommended)

If you prefer manual deployment without GitHub:

1. Zip the `backend_render_enhanced` folder
2. Upload to Render via their interface
3. Configure environment variables
4. Deploy

## ✅ Post-Deployment Verification

### 1. Check Health

```bash
curl https://your-backend.onrender.com/health/detailed
```

Expected response:
```json
{
  "status": "healthy",
  "dependencies": {
    "mongodb": { "status": "healthy" },
    "firebase": { "status": "healthy" }
  }
}
```

### 2. Test Patient Access

Using your Flutter app:
1. Login as a patient
2. Navigate to patient portal
3. Check if prescriptions and lab requests are visible

### 3. Check Logs

In Render dashboard:
1. Go to your service
2. Click "Logs"
3. Look for:
   ```
   GET /patients/.../prescriptions - 200 (XXXms)
   ```
4. If `DEBUG_PATIENT_IDS=true`, you'll see resolution logs

### 4. Monitor for Errors

Watch for any error messages in the logs. Common issues:

**MongoDB connection error:**
- Verify `MONGODB_URI` is correct
- Check MongoDB Atlas allows connections from Render IPs

**Firebase error:**
- Verify `FIREBASE_SERVICE_ACCOUNT` is valid JSON
- Check service account has necessary permissions

**404 or empty responses:**
- Check if patient ID resolution is working
- Verify MongoDB data exists
- Enable debug logging

## 🔄 Updating Your Flutter App

The Flutter app should already work with this backend! But verify the API URL:

**File:** `lib/services/api/api_config.dart`

```dart
class ApiConfig {
  static const String baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://your-backend.onrender.com',  // Update this!
  );
  // ...
}
```

Update the `defaultValue` to your new Render URL.

## 🐛 Troubleshooting

### Issue: Still showing empty lists

**Solution 1: Enable Debug Logging**

In Render, add environment variable:
```
DEBUG_PATIENT_IDS = true
```

Redeploy, then check logs to see what IDs are being resolved.

**Solution 2: Verify Firestore Structure**

Check in Firestore console:
1. `/users/{patient-uid}` - Does it exist?
2. Does it have `role: "patient"`?
3. Does it have a `patientId` field?

**Solution 3: Check Patient Charts**

In Firestore `/patients` collection:
1. Find the patient chart
2. Verify it has `userId` field matching the patient's Firebase UID

### Issue: 500 Internal Server Error

Check Render logs for the actual error. Common causes:
- MongoDB connection failure
- Firebase credentials invalid
- Missing environment variables

### Issue: Slow Performance

**Solution: Add MongoDB Indexes**

In MongoDB Atlas:
```javascript
db.patient_prescriptions.createIndex({ patientId: 1, createdAt: -1 })
db.patient_prescriptions.createIndex({ patientUid: 1, createdAt: -1 })
db.lab_requests.createIndex({ patientId: 1, requestedAt: -1 })
db.lab_requests.createIndex({ patientUid: 1, requestedAt: -1 })
```

## 📊 Monitoring After Deployment

### Day 1-3: Active Monitoring

- [ ] Check Render logs every few hours
- [ ] Test with multiple patient accounts
- [ ] Verify all patients can see their data
- [ ] Monitor response times
- [ ] Check for any error patterns

### Week 1: Regular Checks

- [ ] Daily log review
- [ ] Test new prescriptions/labs
- [ ] Verify data access for new patients
- [ ] Check MongoDB query performance

### Ongoing

- [ ] Weekly log review
- [ ] Monitor `/health/detailed` endpoint
- [ ] Check for slow queries
- [ ] Review error rates

## 🎯 Success Criteria

Deployment is successful when:

✅ All patients can see their prescriptions
✅ All patients can see their lab requests  
✅ No errors in Render logs
✅ Health endpoint returns "healthy"
✅ Response times < 500ms
✅ No user complaints about missing data

## 🔙 Rollback Plan

If something goes wrong:

### Quick Rollback (Render)

1. Go to Render dashboard
2. Select your service
3. Click "Manual Deploy" → "Deploy previous version"
4. Select the previous deployment
5. Confirm

### Full Rollback

1. Revert git commit:
   ```bash
   git revert HEAD
   git push
   ```

2. Render will automatically deploy the reverted version

3. Or manually deploy old code

## 📞 Getting Help

If you encounter issues:

1. **Check the logs** - Most issues are visible in Render logs
2. **Enable debug mode** - Set `DEBUG_PATIENT_IDS=true`
3. **Verify data structure** - Check MongoDB and Firestore
4. **Test health endpoint** - `/health/detailed` shows system status

## 🎉 You're Done!

Once deployed and verified, your patients should now be able to see their prescriptions and lab requests!

**Next Steps:**
1. Monitor for a few days
2. Consider running the migration script to update user profiles
3. Plan to use Firebase UIDs for new prescriptions/labs going forward
