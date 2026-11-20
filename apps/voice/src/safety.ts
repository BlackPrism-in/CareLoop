/**
 * Deterministic backstops that do not depend on the model following its
 * prompt (MVP spec §11: "A prompt is not a hard safety boundary").
 */

const MEDICAL = [
  /\b(report|result|results|test value|reading|level|levels)\b.*\b(mean|means|normal|high|low|bad|serious|ok|okay)\b/i,
  /\b(is it|is this|am i)\b.*\b(serious|dangerous|normal|cancer|infection)\b/i,
  /\b(should i|can i|do i need to)\b.*\b(take|stop|eat|medicine|tablet|dose|worry)\b/i,
  /\b(medicine|medication|tablet|dose|dosage|symptom|pain|fever|bleeding|diagnos\w*)\b/i,
  /(रिपोर्ट|रिज़ल्ट|दवा|दवाई|गोली|बीमारी|दर्द|बुखार|गंभीर|खतरनाक)/,
  /\b(dawai|dawa|goli|bimari|dard|bukhar|gambhir|khatarnak)\b/i,
  // Bengali: report, result, medicine, pill, disease, pain, fever, serious, dangerous, bleeding
  /(রিপোর্ট|ফলাফল|রেজাল্ট|ওষুধ|ঔষধ|বড়ি|ট্যাবলেট|অসুখ|রোগ|ব্যথা|জ্বর|গুরুতর|বিপজ্জনক|রক্তপাত)/,
  /\b(oshudh|osudh|bori|osukh|byatha|betha|jor|jwor|gurutor|bipojjonok)\b/i,
];

export function looksLikeMedicalQuestion(text: string): boolean {
  return MEDICAL.some((r) => r.test(text));
}

const BOOKED_CLAIM = [
  /\b(is|are|'s|'re|has been|have been|i('| ha)ve)\s+(now\s+|all\s+)?(booked|confirmed|scheduled)\b/i,
  /\bbooking (is )?confirmed\b/i,
  /(बुक हो गया|बुक कर दिया|कन्फर्म हो गया|पक्का हो गया)/,
  /(বুক হয়ে গেছে|বুক করা হয়েছে|কনফার্ম হয়ে গেছে|নিশ্চিত হয়ে গেছে|পাকা হয়ে গেছে)/,
];

/** Agent said the booking is confirmed. Only allowed after the adapter confirmed it. */
export function claimsBooked(text: string): boolean {
  return BOOKED_CLAIM.some((r) => r.test(text));
}
