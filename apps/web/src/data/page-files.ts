import bridgeRunbook from "./pages/bridge-runbook.html";
import bridgeRunbookV1 from "./pages/bridge-runbook-v1.html";
import searchResultsLayout from "./pages/search-results-layout.html";
import { files as fixtureFiles } from "./pages-fixtures.json";

export const PAGE_FILES: Record<string, string> = {
  "pages/mission-control.html": "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Mission control</title>\n<style>body{margin:0;padding:16px;font:15px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 6px}ul{margin:0;padding-left:20px}p{margin:0}</style>\n</head>\n<body>\n<h1>Mission control: quarterdeck</h1>\n<p>Live page by Alba. Updated Mon Nov 2, 9:58 AM ET. It refreshes by itself.</p>\n<h2>Lanes</h2>\n<ul><li><b>Settings</b> (Active, Alba): Alba is building the Appearance section; Shelvorn is drafting the Account page. Task Cards: 3.</li><li><b>Search</b> (Active, Dr. Kivo): Dr. Kivo is testing Search groups on the example data. Task Cards: 2.</li><li><b>Mail client</b> (Active, Shelvorn): Shelvorn is writing the mail client plan. Task Cards: 0.</li><li><b>Sidebar and layout</b> (Done, Alba): Done. Nothing running. Task Cards: 0.</li></ul>\n<h2>Bots at work</h2>\n<ul><li><b>Alba</b>: Building the Appearance section</li><li><b>Shelvorn</b>: Drafting the Account page and the invite flow</li><li><b>Dr. Kivo</b>: Testing Search groups</li><li><b>Dale</b>: Building the first export sheet</li><li><b>Iris</b>: Watching the Queue and relaying your notes</li></ul>\n<h2>Task Cards waiting</h2>\n<ul><li>P0 Approve the Settings sections (Shelvorn)</li><li>P1 How many results should each Search group show? (Alba)</li><li>P1 Pick what a new device shows first (Alba)</li><li>P3 Search result grouping (Dr. Kivo)</li><li>P4 Appearance lists System, Light and Dark (Alba)</li></ul>\n</body>\n</html>\n",
  "pages/search-results-layout.html": searchResultsLayout,
  "pages/bridge-runbook.html": bridgeRunbook,
  "pages/bridge-runbook-v1.html": bridgeRunbookV1,
  ...(__QD_FIXTURES__ ? fixtureFiles : {}),
};
