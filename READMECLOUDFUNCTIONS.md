# Cloud Functions BioFloc — déploiement & câblage

Ces fonctions ferment les failles de l'audit qui **ne peuvent pas** l'être côté
navigateur : provisioning d'utilisateurs, révocation de session à la
désactivation d'une ferme, blocage de l'auto-inscription, journal d'audit
centralisé immuable.

> Prérequis : **plan Firebase Blaze** (pay-as-you-go). Les Cloud Functions et
> les *blocking functions* (Identity Platform) exigent Blaze. Aucun coût sans
> trafic ; la facturation est à l'usage.

---

## 1. Fonctions livrées

| Fonction | Type | Remplace / ferme | Appelant autorisé |
|---|---|---|---|
| `blockSelfSignup` | beforeUserCreated | Auto-inscription (HAUT #6) | — (automatique) |
| `provisionUser` | callable | `createOperator` client (CRIT #5) | superadmin ; responsable (Opérateur, sa ferme) |
| `forceResetPassword` | callable | `adminForceResetPassword` (recréation de compte) | superadmin ; responsable (sa ferme) |
| `deleteUserAccount` | callable | `deleteUser` client | superadmin ; responsable (sa ferme) |
| `setFarmActive` | callable | `toggleFarmActivation` + **révocation session** (CRIT #3) | superadmin |
| `mirrorAudit` | trigger Firestore | Journal d'audit central immuable | — (automatique) |
| `bootstrapSuperAdmin` | callable | Amorçage du 1er superadmin | secret d'amorçage |

---

## 2. Déploiement

```bash
cd functions
npm install
cd ..

# déployer fonctions + règles ensemble
firebase deploy --only functions,firestore:rules,storage:rules
```

La *blocking function* `blockSelfSignup` requiert que **Identity Platform** soit
activé (Console → Authentication → Settings → “Blocking functions”). Le premier
`firebase deploy` avec une blocking function propose de l'activer.

---

## 3. Amorçage du premier super-administrateur (une seule fois)

Le compte super-admin (`admin@biofloc.app`) doit avoir un document
`users/{uid}` avec `role: "superadmin"`. Deux options :

**Option A — script Admin SDK (recommandé, aucun code déployé) :**
```bash
# depuis une machine avec une clé de service (GOOGLE_APPLICATION_CREDENTIALS)
node -e "
const admin=require('firebase-admin');admin.initializeApp();
const email='admin@biofloc.app';
admin.auth().getUserByEmail(email).then(u=>
  admin.firestore().collection('users').doc(u.uid).set(
    {uid:u.uid,role:'superadmin'},{merge:true}))
  .then(()=>{console.log('OK');process.exit(0)});
"
```

**Option B — `bootstrapSuperAdmin` :** définir un secret, appeler la fonction
une fois connecté avec le compte admin, puis **retirer le secret** et
redéployer.
```bash
firebase functions:secrets:set BOOTSTRAP_SECRET   # ou variable d'env
# puis, connecté en tant qu'admin dans l'app, dans la console navigateur :
#   firebase.functions('europe-west1').httpsCallable('bootstrapSuperAdmin')({secret:'…'})
```

---

## 4. Câblage côté client (`index.html`)

Ajouter le SDK Functions à côté des autres imports Firebase (lignes 23-26) :

```html
<script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-functions-compat.js"></script>
```

Ajouter à la CSP de `firebase.json` (`connect-src`) le domaine des fonctions —
déjà couvert par `https://*.googleapis.com` (les callables passent par
`cloudfunctions.net`/`run.app` via googleapis). Si un blocage apparaît, ajouter
`https://europe-west1-<PROJET>.cloudfunctions.net`.

Initialiser une référence (après `firebase.initializeApp`) :
```js
const fns = firebase.app().functions('europe-west1');
```

Puis remplacer le **corps** des fonctions sensibles par un appel. Exemples :

**createOperator** (remplacer les lignes 4014-4028 `try{…}`):
```js
try{
  const r = await fns.httpsCallable('provisionUser')({
    farmCode, name, username, password, role, personalEmail
  });
  // plus de secondaryAuth, plus d'écriture users/logins côté client
  await logAudit('modification','Création utilisateur', `${name} (${role}) — ${farmCode}`);
  await loadAdminDashboard();
  msg.style.color='var(--acc)'; msg.textContent=`✅ ${role} "${name}" créé sur ${farmCode}`;
}catch(e){
  msg.style.color='var(--dng)';
  msg.textContent = e.code==='already-exists'
    ? '❌ Cet identifiant existe déjà pour cette ferme'
    : '❌ Erreur : '+e.message;
}
```

**adminForceResetPassword** (remplacer le `try{…}` lignes 5126-5141):
```js
try{
  const r = await fns.httpsCallable('forceResetPassword')({ uid, farmCode });
  hideLoader(); await loadAdminDashboard();
  alert(`✅ Mot de passe réinitialisé !\n\nIdentifiant : ${r.data.username}\n`+
        `Mot de passe temp. : ${r.data.tempPassword}\n\nCommuniquez via WhatsApp.`);
}catch(e){ hideLoader(); alert('❌ Erreur : '+e.message); }
```
> Avantage : `updateUser()` conserve le **même UID** (fin des comptes orphelins
> de l'ancien hack) et révoque les sessions actives.

**deleteUser** → `fns.httpsCallable('deleteUserAccount')({ uid })`.

**toggleFarmActivation** (remplacer l'écriture ligne 5161):
```js
const r = await fns.httpsCallable('setFarmActive')({ farmCode, active: !currentlyActive });
// r.data.sessionsRevoked = nb de sessions coupées à la désactivation
```

Le `secondaryAuth` (app Firebase secondaire) et la fonction
`changePasswordSecondary` peuvent alors être **supprimés** : ils ne servaient
qu'au provisioning client désormais interdit par les règles.

---

## 5. Actions Console restantes (hors code)

- [ ] **Authentication → Settings → User actions** : décocher *Enable create*
      (empêche l'auto-inscription — double sécurité avec `blockSelfSignup`).
- [ ] **App Check** : enregistrer l'app (reCAPTCHA v3 pour le web) et activer
      l'application sur Firestore + Storage (bloque les clients hors-app).
- [ ] **Vérifier les règles déployées** vs le dépôt :
      `firebase firestore:rules get` (lève la contradiction CRIT #5).
- [ ] Confirmer le **plan Blaze** actif.

---

## 6. Ce que ça ferme

- **CRITIQUE #3** — une ferme désactivée : écritures bloquées par `farmActive()`
  (règles) **et** sessions coupées par `revokeRefreshTokens` (`setFarmActive`).
- **CRITIQUE #5** — `users`/`logins` ne sont plus écrits par le navigateur ;
  seul l'Admin SDK (nos fonctions) le fait.
- **HAUT #6** — `blockSelfSignup` rejette toute création de compte cliente.
- **HAUT #12 / session** — révocation serveur des tokens à la désactivation et
  au reset de mot de passe.
- **MOYEN audit** — `auditCentral` immuable, écrit uniquement par `mirrorAudit`,
  lisible par le seul superadmin.
