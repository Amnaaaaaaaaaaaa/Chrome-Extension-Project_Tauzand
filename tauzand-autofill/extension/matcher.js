// matcher.js
//
// JS port of two functions from backend/services/form_filler.py:
// _best_profile_match() and _select_matching_option(). Kept logically
// identical (same hint list, same substring-coverage-bonus idea) so
// behavior stays consistent between the Selenium backend and the extension.

const FIELD_LABEL_HINTS = {
  full_name: ["full name", "your name", "name"],
  first_name: ["first name", "given name"],
  last_name: ["last name", "surname", "family name"],
  // "email address" listed before the bare "email" so a label like "Email
  // Address" scores higher on this specific compound than on the generic
  // "address" key it happens to contain as a substring.
  email: ["email address", "email"],
  phone: ["phone", "mobile", "contact number"],
  address: ["home address", "street address", "mailing address", "address", "street"],
  city: ["city"],
  linkedin_url: ["linkedin"],
  portfolio_url: ["portfolio", "website"],
  referral_source: ["how did you hear", "referral source", "how did you find", "how did you learn about"],
  preferred_work_location: ["preferred work location", "work location", "work arrangement", "remote or on-site"],
  skills: ["which skills", "select your skills", "skills do you have", "technical skills"],
};

const LEGAL_CHECKBOX_KEYWORDS = [
  "i agree", "terms and conditions", "terms of service", "privacy policy",
  "consent", "i accept", "i acknowledge", "i certify", "i confirm that",
  "gdpr", "i authorize",
];

const CHOICE_MATCH_MIN_CONFIDENCE = 0.7;

// Simple string-similarity ratio (0..1), used the same way Python's
// difflib.SequenceMatcher.ratio() was used on the backend. This is not a
// byte-for-byte port of Ratcliff/Obershelp, but is a reasonable equivalent
// for short label/hint comparisons and keeps behavior consistent enough.
function similarityRatio(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;

  // Longest common subsequence length (dynamic programming) as the basis
  // for the ratio, which behaves similarly to SequenceMatcher for this use.
  const dp = Array(shorter.length + 1).fill(0);
  for (let i = 1; i <= longer.length; i++) {
    let prev = 0;
    for (let j = 1; j <= shorter.length; j++) {
      const temp = dp[j];
      dp[j] = longer[i - 1] === shorter[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  const lcsLength = dp[shorter.length];
  return (2 * lcsLength) / (a.length + b.length);
}

/**
 * Mirrors _best_profile_match(): given a question label, returns
 * { profileKey, score } for the best-matching profile field.
 */
function bestProfileMatch(label) {
  const labelLower = label.trim().toLowerCase();
  let bestKey = "unknown";
  let bestScore = 0.0;

  for (const [profileKey, hints] of Object.entries(FIELD_LABEL_HINTS)) {
    for (const hint of hints) {
      let score = similarityRatio(hint, labelLower);
      if (labelLower.includes(hint)) {
        const coverageBonus = 0.25 * (hint.length / Math.max(labelLower.length, 1));
        score = Math.max(score, 0.70 + coverageBonus);
      }
      if (score > bestScore) {
        bestKey = profileKey;
        bestScore = score;
      }
    }
  }
  return { profileKey: bestKey, score: bestScore };
}

/**
 * Mirrors _select_matching_option(): given a list of {text, element} option
 * pairs and a target profile value, returns the best-matching pair or null.
 */
function selectMatchingOption(optionPairs, targetValue, minRatio = 0.55) {
  if (targetValue === null || targetValue === undefined) return null;
  const targetLower = String(targetValue).trim().toLowerCase();
  if (!targetLower) return null;

  let bestPair = null;
  let bestScore = 0.0;

  for (const pair of optionPairs) {
    const optionLower = pair.text.trim().toLowerCase();
    if (!optionLower) continue;
    let score = similarityRatio(optionLower, targetLower);
    if (optionLower.includes(targetLower) || targetLower.includes(optionLower)) {
      const shorterLen = Math.min(optionLower.length, targetLower.length);
      const longerLen = Math.max(optionLower.length, targetLower.length, 1);
      const coverageBonus = 0.25 * (shorterLen / longerLen);
      score = Math.max(score, 0.70 + coverageBonus);
    }
    if (score > bestScore) {
      bestPair = pair;
      bestScore = score;
    }
  }
  return bestScore >= minRatio ? bestPair : null;
}

function isLegalConsentGroup(questionTitle, optionTexts) {
  const haystack = [questionTitle, ...optionTexts].join(" ").toLowerCase();
  return LEGAL_CHECKBOX_KEYWORDS.some((keyword) => haystack.includes(keyword));
}
