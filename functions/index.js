const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

// ════════════════════════════════════════════════════════════════════
//  loginUser — vérification serveur de la connexion + profil ferme
// ════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════
//  saveBassinData — écriture serveur d'un bassin (validation + merge)
// ════════════════════════════════════════════════════════════════════
exports.saveBassinData = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Vous devez être authentifié."
    );
  }

  const uid = context.auth.uid;
  const farmCode = String((data && data.farmCode) || "").trim().toUpperCase();
  const bassinIndex = data && data.bassinIndex;
  const bassinData = (data && data.bassinData) || {};

  if (farmCode === "" || bassinIndex === undefined || bassinIndex === null) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "farmCode et bassinIndex sont requis."
    );
  }

  // L'utilisateur appartient-il bien à cette ferme ?
  const userSnap = await admin.firestore().collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Profil introuvable.");
  }
  if (String(userSnap.data().farmCode || "").trim().toUpperCase() !== farmCode) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Accès refusé à cette ferme."
    );
  }

  // Validation de base du poids : ni chaîne, ni négatif.
  if (bassinData.poids !== undefined && bassinData.poids !== null) {
    const p = bassinData.poids;
    if (typeof p === "string" || typeof p !== "number" || isNaN(p) || p < 0) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Le poids doit être un nombre positif."
      );
    }
  }

  // Écriture fusionnée dans farms/{farmCode}/bassins/{id}
  const docId = String(bassinIndex).padStart(3, "0");
  await admin
    .firestore()
    .collection("farms")
    .doc(farmCode)
    .collection("bassins")
    .doc(docId)
    .set({ ...bassinData, _order: Number(bassinIndex) }, { merge: true });

  return { ok: true, id: docId };
});

// ════════════════════════════════════════════════════════════════════
//  saveSuiviDoc — écrit un document de suivi
// ════════════════════════════════════════════════════════════════════
exports.saveSuiviDoc = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Authentification requise.");
  }
  const uid = context.auth.uid;
  const farmCode = String((data && data.farmCode) || "").trim().toUpperCase();
  const docId = data && data.docId;
  const suiviData = (data && data.suiviData) || {};
  if (farmCode === "" || docId === undefined || docId === null || String(docId) === "") {
    throw new functions.https.HttpsError("invalid-argument", "farmCode et docId sont requis.");
  }
  const userSnap = await admin.firestore().collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Profil introuvable.");
  }
  if (String(userSnap.data().farmCode || "").trim().toUpperCase() !== farmCode) {
    throw new functions.https.HttpsError("permission-denied", "Accès refusé à cette ferme.");
  }
  await admin.firestore()
    .collection("farms").doc(farmCode)
    .collection("suivi").doc(String(docId))
    .set(suiviData);
  return { ok: true, id: String(docId) };
});

// ════════════════════════════════════════════════════════════════════
//  deleteSuiviDoc — supprime un document de suivi
// ════════════════════════════════════════════════════════════════════
exports.deleteSuiviDoc = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Authentification requise.");
  }
  const uid = context.auth.uid;
  const farmCode = String((data && data.farmCode) || "").trim().toUpperCase();
  const docId = data && data.docId;
  if (farmCode === "" || docId === undefined || docId === null || String(docId) === "") {
    throw new functions.https.HttpsError("invalid-argument", "farmCode et docId sont requis.");
  }
  const userSnap = await admin.firestore().collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Profil introuvable.");
  }
  if (String(userSnap.data().farmCode || "").trim().toUpperCase() !== farmCode) {
    throw new functions.https.HttpsError("permission-denied", "Accès refusé à cette ferme.");
  }
  await admin.firestore()
    .collection("farms").doc(farmCode)
    .collection("suivi").doc(String(docId))
    .delete();
  return { ok: true };
});

// ════════════════════════════════════════════════════════════════════
//  saveFeedStock — écrit les lots d'aliments (batch)
// ════════════════════════════════════════════════════════════════════
exports.saveFeedStock = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Authentification requise.");
  }
  const uid = context.auth.uid;
  const farmCode = String((data && data.farmCode) || "").trim().toUpperCase();
  const feedTypes = (data && data.feedTypes) || [];
  if (farmCode === "" || !Array.isArray(feedTypes)) {
    throw new functions.https.HttpsError("invalid-argument", "farmCode et feedTypes (tableau) sont requis.");
  }
  const userSnap = await admin.firestore().collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Profil introuvable.");
  }
  if (String(userSnap.data().farmCode || "").trim().toUpperCase() !== farmCode) {
    throw new functions.https.HttpsError("permission-denied", "Accès refusé à cette ferme.");
  }
  const db = admin.firestore();
  const batch = db.batch();
  feedTypes.forEach((item) => {
    if (item && item.id) {
      batch.set(
        db.collection("farms").doc(farmCode).collection("feed").doc(String(item.id)),
        { batches: item.batches }
      );
    }
  });
  await batch.commit();
  return { ok: true, count: feedTypes.length };
});

// ════════════════════════════════════════════════════════════════════
//  saveConfigData — écrit un document de config (merge)
// ════════════════════════════════════════════════════════════════════
exports.saveConfigData = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Authentification requise.");
  }
  const uid = context.auth.uid;
  const farmCode = String((data && data.farmCode) || "").trim().toUpperCase();
  const configKey = data && data.configKey;
  const configData = (data && data.configData) || {};
  if (farmCode === "" || !configKey) {
    throw new functions.https.HttpsError("invalid-argument", "farmCode et configKey sont requis.");
  }
  const userSnap = await admin.firestore().collection("users").doc(uid).get();
  if (!userSnap.exists) {
    throw new functions.https.HttpsError("not-found", "Profil introuvable.");
  }
  if (String(userSnap.data().farmCode || "").trim().toUpperCase() !== farmCode) {
    throw new functions.https.HttpsError("permission-denied", "Accès refusé à cette ferme.");
  }
  await admin.firestore()
    .collection("farms").doc(farmCode)
    .collection("config").doc(String(configKey))
    .set(configData, { merge: true });
  return { ok: true };
});
