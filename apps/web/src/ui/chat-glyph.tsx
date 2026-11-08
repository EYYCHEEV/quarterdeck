export function ChatGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 5.5h13A1.5 1.5 0 0 1 20 7v8.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5V17H5.5A1.5 1.5 0 0 1 4 15.5V7a1.5 1.5 0 0 1 1.5-1.5z" />
    </svg>
  );
}
