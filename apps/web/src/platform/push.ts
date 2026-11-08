export function canPush(): boolean {
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const homeScreen = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window && (!apple || homeScreen);
}
