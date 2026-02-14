import admin from '../firebase.js';

/**
 * Resolves all possible patient IDs for a given request.
 * 
 * This handles the complex mapping between:
 * - Firebase Auth UIDs
 * - Firestore patient chart document IDs
 * - Legacy patient IDs stored in user profiles
 * 
 * @param {Object} params
 * @param {string} params.requestedId - The patient ID from the request URL
 * @param {string} params.userUid - The authenticated user's Firebase UID
 * @param {Object} params.profile - The user's profile from Firestore
 * @returns {Promise<string[]>} Array of all possible patient IDs to query
 */
export async function resolvePatientIds({ requestedId, userUid, profile }) {
  const patientIds = new Set();
  
  // Always include the requested ID
  patientIds.add(requestedId);
  
  // Check if user is a patient accessing their own data
  const isPatient = profile?.role?.toString?.().toLowerCase?.() === 'patient';
  const isSelfAccess = userUid === requestedId;

  // If the requester is a patient, always include their Firebase UID.
  // In this codebase, staff sometimes reference a patient's Firestore "chart" doc id
  // (patients/{chartId}) while the authenticated patient is identified by Firebase UID.
  // Including the UID ensures patient portal reads can still find Mongo records that
  // were written with patientId = Firebase UID.
  if (isPatient && userUid) {
    patientIds.add(userUid);
  }
  
  // Strategy 1: Check user profile for patientId field
  if (profile?.patientId && profile.patientId.trim() !== '') {
    patientIds.add(profile.patientId.trim());
  }

  // Strategy 1b (patient fallback): If patientId linkage is missing, try to
  // locate the patient's chart by matching stable demographics.
  // This is best-effort and only used to improve patient portal reads when the
  // Firestore `/patients` documents are not linked via `userId`.
  if (isPatient && profile?.phone?.toString().trim().isNotEmpty == true) {
    try {
      const phone = profile.phone.toString().trim();
      const chartsByPhone = await admin
        .firestore()
        .collection('patients')
        .where('phone', '==', phone)
        .limit(5)
        .get();

      if (!chartsByPhone.empty) {
        chartsByPhone.docs.forEach((doc) => patientIds.add(doc.id));
      }
    } catch (error) {
      console.error('[PATIENT_ID_RESOLVER] Phone-based lookup error:', error.message);
    }
  }
  
  // Strategy 2: If patient accessing their own data, try Firestore lookups
  if (isPatient && isSelfAccess) {
    try {
      // Strategy 2a0: Some deployments store the Firebase UID in the patient
      // chart document field `id` (not `userId`). In that setup, the Firestore
      // document id (chart id) is what staff screens often use, and Mongo
      // records may have been written with either value. When the app requests
      // using UID, include any matching chart ids.
      const chartsByIdField = await admin
        .firestore()
        .collection('patients')
        .where('id', '==', requestedId)
        .limit(5)
        .get();

      if (!chartsByIdField.empty) {
        chartsByIdField.docs.forEach((doc) => patientIds.add(doc.id));
      }

      // Strategy 2a: Look for patient chart where userId matches the Firebase UID
      const chartsByUserId = await admin
        .firestore()
        .collection('patients')
        .where('userId', '==', requestedId)
        .limit(5) // Get up to 5 matches in case of duplicates
        .get();
      
      if (!chartsByUserId.empty) {
        chartsByUserId.docs.forEach(doc => {
          patientIds.add(doc.id);
        });
      }
      
      // Strategy 2b: Check if a patient document exists with ID === UID
      const directPatientDoc = await admin
        .firestore()
        .collection('patients')
        .doc(requestedId)
        .get();
      
      if (directPatientDoc.exists) {
        patientIds.add(directPatientDoc.id);
        
        // Also check if this document has a different userId field
        const data = directPatientDoc.data();
        if (data?.userId && data.userId !== requestedId) {
          patientIds.add(data.userId);
        }
      }
    } catch (error) {
      console.error('[PATIENT_ID_RESOLVER] Firestore lookup error:', error.message);
      // Continue with what we have - this is best-effort
    }
  }

  // Strategy 2c: Patient portal may request data using a chart id instead of UID.
  // If the requester is a patient and the requestedId is NOT their UID, try to
  // resolve the requestedId as a chart doc and add its userId (UID) if present.
  if (isPatient && !isSelfAccess && requestedId) {
    try {
      const chartDoc = await admin
        .firestore()
        .collection('patients')
        .doc(requestedId)
        .get();

      if (chartDoc.exists) {
        const data = chartDoc.data();
        if (data?.userId) {
          patientIds.add(data.userId);
        }
      }

      // Also add any charts tied to the authenticated patient's UID.
      if (userUid) {
        // Charts where `id` (patient UID field) matches.
        const chartsByIdField = await admin
          .firestore()
          .collection('patients')
          .where('id', '==', userUid)
          .limit(5)
          .get();

        if (!chartsByIdField.empty) {
          chartsByIdField.docs.forEach((doc) => patientIds.add(doc.id));
        }

        const chartsByUserId = await admin
          .firestore()
          .collection('patients')
          .where('userId', '==', userUid)
          .limit(5)
          .get();

        if (!chartsByUserId.empty) {
          chartsByUserId.docs.forEach(doc => patientIds.add(doc.id));
        }
      }
    } catch (error) {
      console.error('[PATIENT_ID_RESOLVER] Patient chart-id lookup error:', error.message);
    }
  }
  
  // Strategy 3: For staff accessing patient data, try to resolve the chart
  if (!isPatient && requestedId) {
    try {
      // Check if the requested ID is a Firebase UID or a chart ID
      const chartDoc = await admin
        .firestore()
        .collection('patients')
        .doc(requestedId)
        .get();
      
      if (chartDoc.exists) {
        const chartData = chartDoc.data();
        
        // If chart has a userId, include it
        if (chartData?.userId) {
          patientIds.add(chartData.userId);
        }
      } else {
        // Requested ID might be a Firebase UID - try to find the chart
        const chartsByIdField = await admin
          .firestore()
          .collection('patients')
          .where('id', '==', requestedId)
          .limit(1)
          .get();

        if (!chartsByIdField.empty) {
          patientIds.add(chartsByIdField.docs[0].id);
        }

        const chartsByUserId = await admin
          .firestore()
          .collection('patients')
          .where('userId', '==', requestedId)
          .limit(1)
          .get();
        
        if (!chartsByUserId.empty) {
          patientIds.add(chartsByUserId.docs[0].id);
        }
      }
    } catch (error) {
      console.error('[PATIENT_ID_RESOLVER] Chart lookup error:', error.message);
      // Continue with what we have
    }
  }
  
  // Convert Set to Array and filter out empty/null values
  const resolved = Array.from(patientIds).filter(id => id && id.trim() !== '');
  
  // Log for debugging
  if (process.env.DEBUG_PATIENT_IDS === 'true') {
    console.log('[PATIENT_ID_RESOLVER] Input:', { requestedId, userUid, isPatient, isSelfAccess });
    console.log('[PATIENT_ID_RESOLVER] Resolved IDs:', resolved);
  }
  
  return resolved;
}

/**
 * Cache for patient ID mappings to reduce Firestore queries
 * Format: { firebaseUid: [patientId1, patientId2, ...] }
 */
const patientIdCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Cached version of resolvePatientIds for better performance
 */
export async function resolvePatientIdsCached({ requestedId, userUid, profile }) {
  const cacheKey = `${userUid}:${requestedId}`;
  
  // Check cache
  const cached = patientIdCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.ids;
  }
  
  // Resolve and cache
  const ids = await resolvePatientIds({ requestedId, userUid, profile });
  patientIdCache.set(cacheKey, {
    ids,
    timestamp: Date.now()
  });
  
  // Clean up old cache entries
  if (patientIdCache.size > 1000) {
    const now = Date.now();
    for (const [key, value] of patientIdCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        patientIdCache.delete(key);
      }
    }
  }
  
  return ids;
}
