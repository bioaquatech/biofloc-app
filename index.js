const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");

admin.initializeApp();

// ════════════════════════════════════════════════════════════════════
//  Toutes les Cloud Functions callable (loginUser, saveBassinData,
//  saveSuiviDoc, deleteSuiviDoc, saveFeedStock, saveConfigData) ont été
//  retirées : aucune n'était appelée par le code client (index.html écrit
//  directement dans Firestore via firestore.rules, qui applique déjà les
//  mêmes vérifications de manière fiable). Les garder déployées inutilement
//  n'apportait aucune fonctionnalité et augmentait la surface d'attaque
//  (ex. saveConfigData permettait une escalade de privilèges via l'Admin
//  SDK, qui contournait firestore.rules).
// ════════════════════════════════════════════════════════════════════
