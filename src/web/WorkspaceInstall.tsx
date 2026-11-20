import { EllipsisVertical, Share, SquarePlus } from "lucide-react";
import { useEffect, useState } from "react";

type InstallPlatform = "ios" | "android";
type InstallPromptEvent = Event & {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
};

const dismissalKey = "workspace.install.dismissed";

function installPlatform(): InstallPlatform | null {
  if (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
    return "ios";
  return /Android/i.test(navigator.userAgent) ? "android" : null;
}

function isStandalone() {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function useWorkspaceInstall() {
  const [platform] = useState(installPlatform);
  const [standalone, setStandalone] = useState(isStandalone);
  const [installed, setInstalled] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [nativePrompt, setNativePrompt] = useState<InstallPromptEvent | null>(
    null,
  );
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissalKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!platform) return;
    const displayMode = matchMedia("(display-mode: standalone)");
    const onDisplayModeChange = () => setStandalone(isStandalone());
    const onInstalled = () => {
      setNativePrompt(null);
      setGuideOpen(false);
      setInstalled(true);
    };
    const onInstallPrompt = (event: Event) => {
      if (platform !== "android" || isStandalone()) return;
      event.preventDefault();
      setNativePrompt(event as InstallPromptEvent);
    };
    displayMode.addEventListener("change", onDisplayModeChange);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      displayMode.removeEventListener("change", onDisplayModeChange);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [platform]);

  function dismissMenuEntry() {
    setDismissed(true);
    try {
      localStorage.setItem(dismissalKey, "1");
    } catch {
      // Keep the entry hidden for this session when storage is unavailable.
    }
  }

  const available = Boolean(platform) && !standalone && !installed;

  async function open() {
    if (!available || prompting) return;
    if (!nativePrompt) {
      setGuideOpen(true);
      return;
    }
    setPrompting(true);
    try {
      const { outcome } = await nativePrompt.prompt();
      if (outcome === "accepted") setInstalled(true);
      else dismissMenuEntry();
    } catch {
      setGuideOpen(true);
    } finally {
      setNativePrompt((current) => (current === nativePrompt ? null : current));
      setPrompting(false);
    }
  }

  return {
    available,
    showMenuEntry:
      available && !dismissed && (platform === "ios" || Boolean(nativePrompt)),
    guide: available && guideOpen ? platform : null,
    prompting,
    open,
    closeGuide() {
      setGuideOpen(false);
      dismissMenuEntry();
    },
  };
}

export function WorkspaceInstallGuide({
  platform,
  onClose,
}: {
  platform: InstallPlatform;
  onClose: () => void;
}) {
  const ios = platform === "ios";
  const FirstIcon = ios ? Share : EllipsisVertical;
  return (
    <>
      <p className="muted install-guide-intro">
        Open Workspace from your Home Screen.
      </p>
      <ol className="install-guide-steps" role="list">
        <li>
          <span className="install-guide-icon">
            <FirstIcon size={17} aria-hidden="true" />
          </span>
          <span>
            Tap <strong>{ios ? "Share" : "More"}</strong> in{" "}
            {ios ? "Safari" : "Chrome"}.
          </span>
        </li>
        <li>
          <span className="install-guide-icon">
            <SquarePlus size={17} aria-hidden="true" />
          </span>
          <span>
            {ios ? (
              <>
                Choose <strong>Add to Home Screen</strong>, then tap{" "}
                <strong>Add</strong>.
                <small>Keep Open as Web App enabled if shown.</small>
              </>
            ) : (
              <>
                Choose <strong>Install and create shortcut</strong>, then tap{" "}
                <strong>Install</strong>.
              </>
            )}
          </span>
        </li>
      </ol>
      <div className="settings-card-actions">
        <button type="button" className="secondary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}
