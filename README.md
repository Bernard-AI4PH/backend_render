# HomeCare Pro Backend - Enhanced v2.0.0

## 🎯 What's Fixed

This enhanced backend solves the **patient portal access issue** where patients couldn't see their prescriptions and lab requests.

### Key Improvements

1. **Smart Patient ID Resolution** - Automatically handles multiple patient identifier formats
2. **Enhanced Error Handling** - Better logging and error messages
3. **Security Improvements** - Added Helmet, rate limiting, and compression
4. **Health Monitoring** - Comprehensive health check endpoints
5. **Performance Optimizations** - Caching and efficient queries
6. **Better Logging** - Track all operations for debugging

## 🚀 Quick Start

### Prerequisites
- Node.js 20.x
- MongoDB instance
- Firebase project with Admin SDK credentials

### Installation

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your credentials

# Start the server
npm start

# For development with auto-reload
npm run dev
```

### Environment Variables

Create a `.env` file:

```env
# MongoDB
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/homecare_pro

# Firebase Admin SDK (service account key JSON)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}

# Optional
PORT=3000
NODE_ENV=production
ALLOWED_ORIGINS=https://yourdomain.com,https://app.yourdomain.com
DEBUG_PATIENT_IDS=false  # Set to true for debugging patient ID resolution
```

## 📁 Project Structure

```
backend_render_enhanced/
├── index.js                 # Application entry point
├── server.js                # Express app configuration
├── firebase.js              # Firebase Admin initialization
├── mongo.js                 # MongoDB connection
├── package.json             # Dependencies and scripts
├── middleware/              # Express middleware
│   ├── auth.js             # Firebase authentication
│   ├── profile.js          # User profile attachment
│   ├── authz.js            # Authorization helpers
│   └── guards.js           # Role-based guards
├── routes/                  # API route handlers
│   ├── prescriptions.routes.js   # ✨ ENHANCED
│   ├── lab.routes.js              # ✨ ENHANCED
│   ├── health.routes.js           # ✨ NEW
│   ├── patient_notes.routes.js
│   └── telemedicine.routes.js
└── utils/                   # Utility functions
    └── patient-id-resolver.js     # ✨ NEW - Smart ID resolution
```

## 🔧 What Changed

### 1. Patient ID Resolution (`utils/patient-id-resolver.js`)

The new patient ID resolver intelligently handles multiple identification scenarios:

```javascript
// Scenarios handled:
// ✓ Firebase UID → Firestore chart ID
// ✓ Firestore chart ID → Firebase UID
// ✓ User profile patientId field
// ✓ Direct patient document lookup
// ✓ Legacy patient IDs
```

**How it works:**

1. Starts with the requested patient ID
2. Checks user profile for `patientId` field
3. Queries Firestore for patient charts by `userId`
4. Checks if patient document exists with matching ID
5. Returns all possible IDs to query MongoDB with

**Example:**

```javascript
// Patient logs in with Firebase UID: "abc123"
// System resolves to:
// - "abc123" (Firebase UID)
// - "patient_xyz789" (Firestore chart ID)
// - "E9MdQVDP6JJe8Y2GqXAV" (Legacy ID from profile)

// MongoDB query becomes:
db.patient_prescriptions.find({
  $or: [
    { patientId: "abc123" },
    { patientUid: "abc123" },
    { patientId: "patient_xyz789" },
    { patientUid: "patient_xyz789" },
    { patientId: "E9MdQVDP6JJe8Y2GqXAV" },
    { patientUid: "E9MdQVDP6JJe8Y2GqXAV" }
  ]
})
```

### 2. Enhanced Prescription Routes

**Before:**
```javascript
// Simple query that often missed data
{ patientId: requestedId }
```

**After:**
```javascript
// Comprehensive query using resolved IDs
const patientIds = await resolvePatientIds({...});
{
  $or: patientIds.flatMap(id => [
    { patientId: id },
    { patientUid: id }
  ])
}
```

**New Features:**
- Better error handling with try-catch
- Logging for all operations
- Proper 404 responses
- Debug logging support

### 3. Enhanced Lab Routes

Same improvements as prescriptions, plus:
- Handles both `tests` (string) and legacy `type` fields
- Better lab result permissions
- Cascade delete for lab results when request is deleted

### 4. Security Enhancements

```javascript
// Added security middleware
- helmet()          // Security headers
- compression()     // Response compression
- rateLimit()       // DDoS protection
- CORS configuration
```

### 5. Health Check Endpoints

**New endpoints:**

```bash
GET /health          # Basic health check
GET /health/detailed # Full system status
GET /health/ready    # Kubernetes readiness probe
GET /health/live     # Kubernetes liveness probe
```

**Example response:**
```json
{
  "status": "healthy",
  "service": "homecare-pro-api",
  "version": "2.0.0",
  "uptime": 3600,
  "dependencies": {
    "mongodb": { "status": "healthy" },
    "firebase": { "status": "healthy" }
  }
}
```

## 🔍 Debugging

### Enable Debug Logging

```bash
# In .env file
DEBUG_PATIENT_IDS=true
```

This will log:
- Requested patient ID
- User UID and role
- All resolved patient IDs
- MongoDB queries being executed

**Example log output:**
```
[PATIENT_ID_RESOLVER] Input: {
  requestedId: 'E9MdQVDP6JJe8Y2GqXAV',
  userUid: 'abc123',
  isPatient: true,
  isSelfAccess: false
}
[PATIENT_ID_RESOLVER] Resolved IDs: [
  'E9MdQVDP6JJe8Y2GqXAV',
  'abc123',
  'patient_xyz789'
]
[PRESCRIPTIONS] Resolved patient IDs: [
  'E9MdQVDP6JJe8Y2GqXAV',
  'abc123',
  'patient_xyz789'
]
```

### Monitor Requests

All requests are logged with timing:

```
GET /patients/abc123/prescriptions - 200 (45ms)
POST /patients/abc123/lab_requests - 201 (120ms)
```

## 📊 MongoDB Data Structure

The backend now handles all these variations:

### Prescriptions
```javascript
{
  _id: ObjectId("..."),
  patientId: "E9MdQVDP6JJe8Y2GqXAV",  // or Firebase UID
  // OR
  patientUid: "abc123",                // Alternative field name
  medication: "Lisinopril",
  dosage: "10mg",
  // ... other fields
}
```

### Lab Requests
```javascript
{
  _id: ObjectId("..."),
  patientId: "E9MdQVDP6JJe8Y2GqXAV",  // or Firebase UID
  // OR
  patientUid: "abc123",                // Alternative field name
  tests: "FBC",                        // String format
  // OR
  type: "FBC",                         // Legacy field
  // ... other fields
}
```

## 🚀 Deployment to Render

### Method 1: Direct Deploy

1. Push this code to GitHub
2. Connect GitHub repo to Render
3. Set environment variables in Render dashboard
4. Deploy!

### Method 2: Manual Deploy

```bash
# Build and deploy
git add .
git commit -m "Deploy enhanced backend v2.0.0"
git push origin main
```

### Render Configuration

**Build Command:** (leave empty)
**Start Command:** `npm start`

**Environment Variables:**
```
MONGODB_URI=your-mongodb-connection-string
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
NODE_ENV=production
```

## 🧪 Testing

### Test Patient Access

```bash
# Get a Firebase ID token
# Then test the endpoints

curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-backend.onrender.com/patients/YOUR_UID/prescriptions

curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://your-backend.onrender.com/patients/YOUR_UID/lab_requests
```

### Health Check

```bash
curl https://your-backend.onrender.com/health/detailed
```

## 📝 API Endpoints

### Prescriptions

```
GET    /patients/:patientId/prescriptions        # List all prescriptions
POST   /patients/:patientId/prescriptions        # Create prescription (doctor/admin)
PATCH  /patients/:patientId/prescriptions/:rxId  # Update prescription (doctor/admin)
DELETE /patients/:patientId/prescriptions/:rxId  # Delete prescription (admin only)
```

### Lab Requests

```
GET    /patients/:patientId/lab_requests                 # List all lab requests
POST   /patients/:patientId/lab_requests                 # Create lab request (doctor/admin)
PATCH  /patients/:patientId/lab_requests/:labId          # Update lab request (doctor/admin)
DELETE /patients/:patientId/lab_requests/:labId          # Delete lab request (admin only)
```

### Lab Results

```
GET    /patients/:patientId/lab_requests/:labId/results            # List results
POST   /patients/:patientId/lab_requests/:labId/results            # Upload result
PATCH  /patients/:patientId/lab_requests/:labId/results/:resultId  # Update result
DELETE /patients/:patientId/lab_requests/:labId/results/:resultId  # Delete result
```

### Health

```
GET /health          # Basic health check
GET /health/detailed # Detailed system status
GET /health/ready    # Readiness probe
GET /health/live     # Liveness probe
```

## 🔐 Authentication

All endpoints (except `/health`) require Firebase authentication:

```javascript
headers: {
  'Authorization': 'Bearer <firebase-id-token>',
  'Content-Type': 'application/json'
}
```

## 🎯 Migration Path

### From Previous Backend

No data migration needed! The enhanced backend is **backward compatible** and works with existing data.

**What happens:**
1. Old prescriptions with `patientId` = chart ID → Still accessible ✓
2. New prescriptions with `patientId` = Firebase UID → Accessible ✓
3. Mixed data → All accessible via smart resolution ✓

### Recommended Actions

1. **Update Patient Profiles** - Run the migration script to add `patientId` field to all patient users
2. **Going Forward** - Create new prescriptions/labs using Firebase UID as `patientId`
3. **Monitor** - Watch logs to ensure all patients can access their data

## 🐛 Troubleshooting

### Issue: Patients still can't see data

**Check:**
1. Is the backend deployed and running?
   ```bash
   curl https://your-backend.onrender.com/health
   ```

2. Are patient IDs being resolved?
   - Enable `DEBUG_PATIENT_IDS=true`
   - Check backend logs

3. Does MongoDB have the data?
   - Check MongoDB Atlas for prescriptions/lab_requests collections
   - Verify `patientId` fields match resolved IDs

### Issue: Slow response times

**Solutions:**
1. Patient ID resolution caching is enabled by default
2. Add MongoDB indexes:
   ```javascript
   db.patient_prescriptions.createIndex({ patientId: 1, createdAt: -1 })
   db.patient_prescriptions.createIndex({ patientUid: 1, createdAt: -1 })
   db.lab_requests.createIndex({ patientId: 1, requestedAt: -1 })
   db.lab_requests.createIndex({ patientUid: 1, requestedAt: -1 })
   ```

### Issue: 401 Unauthorized errors

**Check:**
1. Firebase ID token is valid and not expired
2. User profile exists in Firestore `/users/{uid}`
3. Firebase service account credentials are correct

## 📈 Performance

### Optimizations Included

1. **Caching** - Patient ID resolution cached for 5 minutes
2. **Indexes** - MongoDB queries optimized with compound indexes
3. **Compression** - Response compression enabled
4. **Connection Pooling** - MongoDB connection pool managed efficiently

### Monitoring

Use health endpoints to monitor:
- System uptime
- MongoDB connectivity
- Firebase connectivity
- Response times (logged for each request)

## 🔄 Updates & Maintenance

### Updating Dependencies

```bash
npm update
npm audit fix
```

### Viewing Logs (Render)

1. Go to Render dashboard
2. Select your service
3. Click "Logs" tab
4. Filter by severity or search

## 🤝 Support

If issues persist:
1. Check the logs with `DEBUG_PATIENT_IDS=true`
2. Review MongoDB data structure
3. Verify Firebase user profiles
4. Check network connectivity

## 📄 License

Proprietary - Fausford HomeCare System

## 🎉 Version History

### v2.0.0 (Current)
- ✨ Smart patient ID resolution
- ✨ Enhanced security with Helmet
- ✨ Health check endpoints
- ✨ Comprehensive error handling
- ✨ Debug logging support
- 🐛 Fixed patient portal access issue
- 🚀 Performance optimizations

### v1.0.0
- Initial release
- Basic API endpoints
- MongoDB integration
- Firebase authentication
