/** Only operations that derive a new `<name>.md` need a portable filename stem. */
export function isAgentPresetFileName(name: string): boolean {
  return (
    name.trim().length > 0 &&
    !/[<>:"/\\|?*]/u.test(name) &&
    !Array.from(name).some((char) => char.charCodeAt(0) < 32) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(name)
  );
}
