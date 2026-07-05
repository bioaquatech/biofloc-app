const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

exports.loginUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Vous devez être authentifié pour vous connecter."
    );
  }

  const uid = context.auth.uid;
  const farmCode = String((data && data.farmCode) || "").trim().toUpperCase();

  const userSnap = await admin.firestore().collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError(
      "not-found",
      "Profil utilisateur introuvable."
    );
  }
  const userData = userSnap.data();

  if (String(userData.farmCode || "").trim().toUpperCase() !== farmCode) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Accès refusé à cette ferme."
    );
  }

  const farmSnap = await admin.firestore().collection("farms").doc(farmCode).get();
  if (!farmSnap.exists) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Ferme introuvable."
    );
  }
  const farmData = farmSnap.data();
  if (farmData.active === false) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Ferme désactivée. Contactez l'administrateur."
    );
  }

  return {
    uid: uid,
    name: userData.name || "",
    role: userData.role || "Opérateur",
    farmCode: farmCode,
    farmName: farmData.name || farmCode,
    canBackup: userData.canBackup === true,
    farmMessages: farmData.farmMessages || [],
  };
});