export function PasswordField({ value, onText }: { value: string; onText: (text: string) => void }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-meta font-medium text-ink-2">Approval password</span>
      <input
        type="password"
        value={value}
        onChange={(event) => onText(event.target.value)}
        autoComplete="off"
        data-testid="approval-password"
        className="min-h-12 w-full rounded-control border border-line-3 bg-well px-3.5 text-base text-ink outline-none focus:border-brass"
      />
    </label>
  );
}
