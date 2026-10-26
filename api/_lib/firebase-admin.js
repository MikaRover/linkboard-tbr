// firebase-admin v14 removed the old namespaced API (admin.firestore(),
// admin.credential.cert, admin.apps ...). This tiny shim rebuilds exactly the
// parts LinkBoard uses on top of the new modular API, so the rest of the code
// keeps working unchanged after the security upgrade (v12 had known
// vulnerabilities, v14 has none).
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const admin = {
  get apps() { return getApps(); },
  initializeApp: (opts) => initializeApp(opts),
  credential: { cert },
  auth: () => getAuth(),
};
admin.firestore = () => getFirestore();
admin.firestore.FieldValue = FieldValue;
admin.firestore.Timestamp = Timestamp;

module.exports = admin;
