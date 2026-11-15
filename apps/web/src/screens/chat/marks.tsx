import type { ReactNode } from "react";
import { hasHidden, hiddenParts, shownText } from "../../domain/hidden-chars";
import { MarkedText } from "../../ui/marked-text";
import type { TextMarks } from "../../ui/markdown";

export const drawMarks = (text: string): ReactNode => (hasHidden(text) ? <MarkedText parts={hiddenParts(text)} /> : text);

export const MARKS: TextMarks = { draw: drawMarks, shown: shownText };
