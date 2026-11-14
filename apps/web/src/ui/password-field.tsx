export function PasswordField({ value, onText }: { value: string; onText: (text: string) => void }) {
  return (
    <label className="grid gap-s1">
      <span className="text-meta font-strong text-ink-2">Approval password</span>
      <input
        type="password"
        value={value}
        onChange={(event) => onText(event.target.value)}
        autoComplete="off"
        data-testid="approval-password"
        className="min-h-s7 w-full rounded-key border border-line-3 bg-well px-s3 text-body text-ink outline-none focus:border-hand pointer-coarse:text-lead"
      />
    </label>
  );
}
