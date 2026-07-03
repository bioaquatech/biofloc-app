/**
 * BioFloc ERP — Cloud Functions (Admin SDK)
 * ==========================================
 * Ces fonctions déplacent les opérations sensibles HORS du navigateur, où
 * le code client ne peut pas être une source d'autorité. Elles ferment les
 * failles suivantes de l'audit :
 *
 *   - CRITIQUE #3 / H3  : révocation de session à la désactivation d'une ferme
 *   - CRITIQUE #5       : provisioning utilisateurs déplacé côté serveur
 *   - HAUT #6           : auto-inscription bloquée (beforeUserCreated)
 *   - MOYEN (audit)     : journal d'audit centralisé et immuable
 *
 * Modèle d'autorisation : le rôle fait autorité dans users/{uid}.role, lu ici
 * via l'Admin SDK (qui ignore les règles Firestore). Le client ne fait que
 * demander ; c'est le serveur qui vérifie l'appelant à chaque fois.
 *
 * Région : europe-west1 (la plus proche de l'Afrique de l'Ouest).
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { beforeUserCreated } = require("firebase-functions/identity");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");

initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

const db = getFirestore();
const auth = getAuth();

const SUPERADMIN_ROLES = ["superadmin", "SuperAdmin", "Administrateur"];
const RESPONSABLE_ROLES = ["Responsable"];
const EMAIL_DOMAIN = "biofloc.app";

/* ─────────────────────────────────────────────────────────────
 *  Helpers
 * ───────────────────────────────────────────────────────────── */

// Normalise username/farmCode exactement comme le client (index.html:4012)
function derivedEmail(username, farmCode) {
  const u = String(username).toLowerCase().replace(/[^a-z0-9]/g, "");
  const f = String(farmCode).toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${u}_${f}@${EMAIL_DOMAIN}`;
}

// Charge le profil de l'appelant depuis Firestore (source d'autorité du rôle)
async function loadCaller(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Connexion requise.");
  }
  const snap = await db.collection("users").doc(request.auth.uid).get();
  if (!snap.exists) {
    throw new HttpsError("permission-denied", "Profil introuvable.");
  }
  return { uid: request.auth.uid, ...snap.data() };
}

function isSuperAdmin(caller) {
  return SUPERADMIN_ROLES.includes(caller.role);
}

function assertSuperAdmin(caller) {
  if (!isSuperAdmin(caller)) {
    throw new HttpsError("permission-denied", "Réservé à l'administrateur.");
  }
}

// Un Responsable ne peut agir que sur SA ferme ; un superadmin partout.
function assertCanManageFarm(caller, farmCode) {
  if (isSuperAdmin(caller)) return;
  if (RESPONSABLE_ROLES.includes(caller.role) && caller.farmCode === farmCode) return;
  throw new HttpsError("permission-denied", "Droits insuffisants sur cette ferme.");
}

function genTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#";
  let p = "";
  for (let i = 0; i < 12; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p;
}

/* ─────────────────────────────────────────────────────────────
 *  1. BLOQUER L'AUTO-INSCRIPTION  (faille HAUT #6)
 *  Les blocking functions ne se déclenchent PAS pour les créations
 *  faites via l'Admin SDK (nos fonctions provisionUser/forceReset).
 *  Toute tentative createUserWithEmailAndPassword() côté navigateur
 *  est donc rejetée.
 * ───────────────────────────────────────────────────────────── */

exports.blockSelfSignup = beforeUserCreated((event) => {
  logger.warn("Tentative d'auto-inscription bloquée", {
    email: event.data && event.data.email,
  });
  throw new HttpsError(
    "permission-denied",
    "La création de compte est réservée à l'administration."
  );
});

/* ─────────────────────────────────────────────────────────────
 *  2. PROVISIONNER UN UTILISATEUR  (remplace createOperator client)
 * ───────────────────────────────────────────────────────────── */

exports.provisionUser = onCall(async (request) => {
  const caller = await loadCaller(request);
  const { farmCode, name, username, password, role, personalEmail, canBackup } = request.data || {};

  if (!farmCode || !name || !username || !password) {
    throw new HttpsError("invalid-argument", "Champs obligatoires manquants.");
  }
  if (String(password).length < 6) {
    throw new HttpsError("invalid-argument", "Mot de passe : 6 caractères minimum.");
  }
  const targetRole = role || "Opérateur";
  // Un Responsable peut créer des Opérateurs sur sa ferme ; seul un superadmin
  // peut créer des Responsables/Administrateurs ou opérer sur une autre ferme.
  assertCanManageFarm(caller, farmCode);
  if (!isSuperAdmin(caller) && !["Opérateur"].includes(targetRole)) {
    throw new HttpsError("permission-denied", "Seul l'administrateur crée ce rôle.");
  }

  const email = derivedEmail(username, farmCode);
  let userRecord;
  try {
    userRecord = await auth.createUser({ email, password, displayName: name });
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "Cet identifiant existe déjà pour cette ferme.");
    }
    throw new HttpsError("internal", "Création échouée : " + e.message);
  }

  const uid = userRecord.uid;
  const loginId = `${farmCode}_${username}`;
  const batch = db.batch();
  batch.set(db.collection("users").doc(uid), {
    uid, email, name, username, farmCode, role: targetRole,
    personalEmail: personalEmail || null,
    canBackup: canBackup === true,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: caller.uid,
  });
  batch.set(db.collection("logins").doc(loginId), {
    authEmail: email, personalEmail: personalEmail || null, uid, farmCode,
  });
  await batch.commit();

  return { ok: true, uid, email };
});

/* ─────────────────────────────────────────────────────────────
 *  3. RÉINITIALISER UN MOT DE PASSE  (remplace adminForceResetPassword)
 *  Utilise updateUser() : plus besoin de recréer le compte (l'ancien
 *  hack changeait l'UID et laissait des orphelins). On révoque aussi
 *  les tokens pour couper les sessions actives.
 * ───────────────────────────────────────────────────────────── */

exports.forceResetPassword = onCall(async (request) => {
  const caller = await loadCaller(request);
  const { uid, farmCode } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid manquant.");

  const targetSnap = await db.collection("users").doc(uid).get();
  if (!targetSnap.exists) throw new HttpsError("not-found", "Utilisateur introuvable.");
  const target = targetSnap.data();
  assertCanManageFarm(caller, farmCode || target.farmCode);

  const newPassword = genTempPassword();
  try {
    await auth.updateUser(uid, { password: newPassword });
    await auth.revokeRefreshTokens(uid); // coupe les sessions ouvertes
  } catch (e) {
    throw new HttpsError("internal", "Réinitialisation échouée : " + e.message);
  }
  return { ok: true, username: target.username, tempPassword: newPassword };
});

/* ─────────────────────────────────────────────────────────────
 *  4. SUPPRIMER UN UTILISATEUR  (remplace deleteUser client)
 * ───────────────────────────────────────────────────────────── */

exports.deleteUserAccount = onCall(async (request) => {
  const caller = await loadCaller(request);
  const { uid } = request.data || {};
  if (!uid) throw new HttpsError("invalid-argument", "uid manquant.");
  if (uid === caller.uid) {
    throw new HttpsError("failed-precondition", "Auto-suppression interdite.");
  }

  const targetSnap = await db.collection("users").doc(uid).get();
  const target = targetSnap.exists ? targetSnap.data() : null;
  if (target) assertCanManageFarm(caller, target.farmCode);
  else assertSuperAdmin(caller);

  try {
    await auth.deleteUser(uid).catch(() => {}); // tolère un compte déjà absent
  } catch (e) {
    throw new HttpsError("internal", "Suppression auth échouée : " + e.message);
  }
  const batch = db.batch();
  batch.delete(db.collection("users").doc(uid));
  if (target && target.username && target.farmCode) {
    batch.delete(db.collection("logins").doc(`${target.farmCode}_${target.username}`));
  }
  await batch.commit();
  return { ok: true };
});

/* ─────────────────────────────────────────────────────────────
 *  5. ACTIVER / DÉSACTIVER UNE FERME  (+ révocation de session)
 *  À la désactivation, on révoque les tokens de TOUS les membres :
 *  couplé à la règle farmActive() côté Firestore, cela coupe l'accès
 *  immédiatement — plus de « session qui survit » (faille CRITIQUE #3).
 * ───────────────────────────────────────────────────────────── */

exports.setFarmActive = onCall(async (request) => {
  const caller = await loadCaller(request);
  assertSuperAdmin(caller); // seul le superadmin gère les abonnements
  const { farmCode, active } = request.data || {};
  if (!farmCode || typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "farmCode / active requis.");
  }

  await db.collection("farms").doc(farmCode).set({ active }, { merge: true });

  let revoked = 0;
  if (active === false) {
    const members = await db.collection("users").where("farmCode", "==", farmCode).get();
    await Promise.all(
      members.docs.map(async (d) => {
        try { await auth.revokeRefreshTokens(d.id); revoked++; } catch (_) {}
      })
    );
  }
  return { ok: true, active, sessionsRevoked: revoked };
});

/* ─────────────────────────────────────────────────────────────
 *  6. AUDIT CENTRALISÉ ET IMMUABLE
 *  Miroir en append-only des journaux de ferme vers une collection
 *  globale que seul le superadmin peut lire. Attribution serveur :
 *  l'uid est réécrit depuis la donnée déjà validée par les règles
 *  (uid == auth.uid), et le timestamp serveur fait foi.
 * ───────────────────────────────────────────────────────────── */

exports.mirrorAudit = onDocumentCreated(
  "farms/{farmCode}/audit/{auditId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() || {};
    await db.collection("auditCentral").add({
      farmCode: event.params.farmCode,
      auditId: event.params.auditId,
      uid: d.uid || null,
      userName: d.userName || null,
      userRole: d.userRole || null,
      type: d.type || null,
      action: d.action || null,
      detail: d.detail || null,
      clientTime: d.timestampLocal || null,
      serverTime: FieldValue.serverTimestamp(),
    });
  }
);

/* ─────────────────────────────────────────────────────────────
 *  7. BOOTSTRAP : promouvoir le premier super-administrateur
 *  Sécurisé par un secret d'amorçage (variable d'environnement
 *  BOOTSTRAP_SECRET). À utiliser UNE fois, puis retirer le secret.
 *  Voir README-CLOUD-FUNCTIONS.md.
 * ───────────────────────────────────────────────────────────── */

exports.bootstrapSuperAdmin = onCall(async (request) => {
  const secret = process.env.BOOTSTRAP_SECRET;
  if (!secret) {
    throw new HttpsError("failed-precondition", "Bootstrap désactivé.");
  }
  if (!request.data || request.data.secret !== secret) {
    throw new HttpsError("permission-denied", "Secret invalide.");
  }
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Connectez-vous d'abord.");
  }
  const uid = request.auth.uid;
  await db.collection("users").doc(uid).set(
    { uid, role: "superadmin", bootstrappedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  return { ok: true, uid };
});
