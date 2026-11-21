// =====================================================
// FORMULES D'ABONNEMENT
// Firestore comptes/{googleId}.premium :
//   "Statistiques" → formule Statistiques (2 comptes reliés)
//   "Createur"     → formule Créateur (5 comptes reliés)
//   absent / false → gratuit (1 compte relié)
// Majuscules et accents ignorés ("createur", "Créateur"…).
// Anciennes valeurs encore acceptées : premium = true (+ formule = "createur").
// =====================================================

function normalize(v) {
    return String(v).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

// "gratuit" | "statistiques" | "createur"
function formuleOf(premium, legacyFormule) {
    if (premium === true) return normalize(legacyFormule || "") === "createur" ? "createur" : "statistiques";
    if (typeof premium !== "string") return "gratuit";
    const v = normalize(premium);
    if (v === "createur") return "createur";
    if (v === "statistiques" || v === "stats" || v === "premium" || v === "true") return "statistiques";
    return "gratuit";
}

// Formule d'un document Firestore (compte Google ou ancienne fiche « utilisateurs »).
function formuleOfDoc(doc) {
    if (!doc?.exists) return "gratuit";
    return formuleOf(doc.get("premium"), doc.get("formule"));
}

const isPaid = formule => formule === "statistiques" || formule === "createur";

module.exports = { formuleOf, formuleOfDoc, isPaid };
