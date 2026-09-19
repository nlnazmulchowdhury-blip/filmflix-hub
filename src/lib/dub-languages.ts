/**
 * Languages offered for AI auto-dubbing (ElevenLabs). ISO-639-1 codes.
 * Lives in a dependency-free file so both the browser (admin panel) and the
 * Convex backend can import it without pulling server code into the client.
 */
export const DUB_LANGUAGES: { code: string; label: string }[] = [
  { code: "bn", label: "Bengali" },
  { code: "hi", label: "Hindi" },
  { code: "ur", label: "Urdu" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "mr", label: "Marathi" },
  { code: "ne", label: "Nepali" },
  { code: "en", label: "English" },
];
