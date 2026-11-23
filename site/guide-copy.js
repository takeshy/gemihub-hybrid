export const GUIDE_GREETING = "この街について、どんなことを知りたいですか？イベントや公共施設、地域のお知らせ、お店の紹介までご案内します。";
const ENGLISH_GREETING = "What would you like to know about the neighborhood? Ask me about local shops, events, or public facilities.";

// Saved page designs can still contain the former default, including an area name.
// Update only that known wording; keep other operator-written greetings intact.
export function guideGreeting(value, language) {
  if (!value) return language === "en" ? ENGLISH_GREETING : GUIDE_GREETING;
  const legacy = /^(?:(.{1,80})で)?どんなお店をお探しですか？(?:雑貨店などのお店紹介から、|美容サロンや雑貨店のご紹介から、)飲食店の予約相談までお手伝いします。$/u.exec(value);
  if (!legacy) return value;
  return legacy[1] ? GUIDE_GREETING.replace("この街について、", `${legacy[1]}の街について、`) : GUIDE_GREETING;
}
