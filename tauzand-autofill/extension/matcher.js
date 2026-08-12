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
  current_location: ["current location", "location"],
  requires_visa_sponsorship: ["now or in the future require", "will you in the future require immigration sponsorship", "require immigration sponsorship"],
  currently_enrolled: ["will return to the program upon completion", "currently enrolled in a university"],
  veteran_status: ["veteran status", "protected veteran"],
  disability_status: ["disability status", "do you have a disability"],
  current_company: ["current company", "current employer", "where do you currently work"],
  eu_efta_citizen: ["citizen of a country in the eu", "eu/efta", "european union"],
  languages: ["languages", "which languages", "language proficiency", "language skill"],
  date_of_birth: ["date of birth", "birth date", "birthday", "dob"],
  postal_code: ["postal code", "zip code", "zip", "postcode"],
  field_of_study: ["field of study", "major", "area of study"],
  cgpa: ["cgpa", "gpa", "overall result", "grade point average"],
  education_start_year: ["first year attended", "start year", "year started", "from"],
  non_compete_restrictions: ["non-compete", "non compete", "non-solicitation", "non solicitation"],
  us_government_employee: ["current or former employee of the united states government", "employee of the united states government", "us government"],
  export_control_restricted_country: ["export control laws", "iran, cuba, north korea, syria", "citizen, national or resident of any of the following countries"],
  linkedin_url: ["linkedin"],
  portfolio_url: ["portfolio", "website"],
  referral_source: ["how did you hear", "how you heard", "referral source", "how did you find", "how did you learn about"],
  preferred_work_location: ["preferred work location", "work location", "work arrangement", "remote or on-site"],
  skills: ["type to add skills", "which skills", "select your skills", "skills do you have", "technical skills", "skills"],
  pronouns: ["pronouns", "preferred pronouns"],
  work_authorized_us: ["authorized to work", "work authorization", "legally authorized"],
  visa_sponsorship_status: ["require sponsorship", "visa sponsorship", "sponsorship for employment"],
  willing_to_relocate: ["willing to relocate", "able to relocate", "relocate for this role", "relocating for this role", "consider relocating"],
  github_url: ["github"],
  school: ["school", "university", "college"],
  graduation_date: ["expect to graduate or complete your program", "intended graduation year", "to (actual or expected)", "graduation date", "expected graduation", "when do you expect to graduate"],
  degree_type: ["what degree are you currently pursuing", "degree type", "degree you are", "what degree", "degree"],
  prior_internships_count: ["prior internships", "how many internships", "number of internships"],
  gender: ["gender identity", "gender"],
  race: ["race", "ethnicity", "race & ethnicity", "race and ethnicity"],
};

const LEGAL_CHECKBOX_KEYWORDS = [
  "i agree", "terms and conditions", "terms of service", "privacy policy",
  "consent", "i accept", "i acknowledge", "i certify", "i confirm that",
  "gdpr", "i authorize", "non-disclosure agreement", "nondisclosure agreement",
  "arbitration agreement", "read and agree",
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

// Strips apostrophes entirely and collapses other punctuation/whitespace to
// single spaces, so "Bachelor's" and "Bachelors" (or any other punctuation
// variant) compare as identical. Used on top of the existing similarity
// scoring, not instead of it — this only removes noise that was causing
// otherwise-correct matches to score too low.
function normalizeForMatch(s) {
  return s.toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Mirrors _select_matching_option(): given a list of {text, element} option
 * pairs and a target profile value, returns the best-matching pair or null.
 */
function selectMatchingOption(optionPairs, targetValue, minRatio = 0.55) {
  if (targetValue === null || targetValue === undefined) return null;
  const targetLower = String(targetValue).trim().toLowerCase();
  if (!targetLower) return null;
  const targetNormalized = normalizeForMatch(targetLower);
  // Confirmed via testing: stripping punctuation can reduce a short
  // technical term (e.g. "C++") down to almost nothing (just "c"), which
  // then appears as a substring in tons of unrelated words and wins the
  // coverage bonus incorrectly (e.g. "TypeScript" matching "C++" because
  // "typescript" contains the letter "c"). Only trust the normalized
  // comparison when both sides are long enough for a substring match to
  // actually mean something.
  const MIN_NORMALIZED_LEN_FOR_COVERAGE = 3;

  let bestPair = null;
  let bestScore = 0.0;

  for (const pair of optionPairs) {
    const optionLower = pair.text.trim().toLowerCase();
    if (!optionLower) continue;
    const optionNormalized = normalizeForMatch(optionLower);

    let score = Math.max(similarityRatio(optionLower, targetLower), similarityRatio(optionNormalized, targetNormalized));
    const normalizedCoverageEligible =
      optionNormalized.length >= MIN_NORMALIZED_LEN_FOR_COVERAGE && targetNormalized.length >= MIN_NORMALIZED_LEN_FOR_COVERAGE;
    if (
      optionLower.includes(targetLower) || targetLower.includes(optionLower) ||
      (normalizedCoverageEligible && (optionNormalized.includes(targetNormalized) || targetNormalized.includes(optionNormalized)))
    ) {
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

// For open-text (textarea) questions where the candidate explains something
// with real legal weight — distinct from LEGAL_CHECKBOX_KEYWORDS, which is
// about consent checkboxes that are never auto-checked. These are prose
// fields the candidate writes themselves; the AI Suggest button offers a
// draft, and this separate detector flags when that draft (or anything
// already typed) is worth an explicit legal-risk check before submitting.
const LEGAL_TEXT_KEYWORDS = [
  "conviction", "convicted", "lawsuit", "litigation", "criminal history",
  "criminal record", "felony", "misdemeanor", "dispute with", "legal action",
  "legal proceeding", "non-compete", "non compete", "confidentiality obligation",
  "explain any", "describe any", "describe the circumstances",
];

function isLegalSensitiveTextQuestion(questionTitle) {
  const haystack = questionTitle.toLowerCase();
  return LEGAL_TEXT_KEYWORDS.some((keyword) => haystack.includes(keyword));
}