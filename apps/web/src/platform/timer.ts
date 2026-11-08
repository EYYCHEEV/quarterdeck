export type Schedule = (run: () => void, delay: number) => () => void;

export const schedule: Schedule = (run, delay) => {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
};
