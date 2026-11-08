export const INTL_SAMPLES = [
  {
    name: "Turkish dotted and dotless i",
    text: "\u0130stanbul ekibi \u0130zmir notlar\u0131n\u0131 okudu",
    finds: [
      ["\u0130zmir", ["\u0130zmir"]],
      ["notlar\u0131n\u0131", ["notlar\u0131n\u0131"]],
      ["okudu", ["okudu"]],
    ],
  },
  {
    name: "German sharp s",
    text: "Gr\u00f6\u00dfe der Stra\u00dfe, \u1e9e als Gro\u00dfbuchstabe",
    finds: [
      ["gr\u00f6\u00dfe", ["Gr\u00f6\u00dfe"]],
      ["Stra\u00dfe", ["Stra\u00dfe"]],
      ["gro\u00dfbuchstabe", ["Gro\u00dfbuchstabe"]],
    ],
  },
  {
    name: "emoji",
    text: "Build \u{1F680} ok \u2705 by \u{1F469}\u200D\u{1F4BB} Dale",
    finds: [
      ["ok", ["ok"]],
      ["dale", ["Dale"]],
    ],
  },
  {
    name: "right-to-left line",
    text: "\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd, \u0628\u0646\u0627\u0621 \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u062c\u0627\u0647\u0632",
    finds: [
      ["\u05e2\u05d5\u05dc\u05dd", ["\u05e2\u05d5\u05dc\u05dd"]],
      ["\u0627\u0644\u062a\u0637\u0628\u064a\u0642", ["\u0627\u0644\u062a\u0637\u0628\u064a\u0642"]],
    ],
  },
];
