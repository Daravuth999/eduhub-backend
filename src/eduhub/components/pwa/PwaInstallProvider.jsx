// PwaInstallProvider.jsx — glues usePwaInstall + banner + modal and
// exposes the install state via React context so InstallButton
// (in the Header) can share the same session-scoped state.
import React, { createContext, useContext, useMemo, useState, useEffect } from "react";
import usePwaInstall from "../../hooks/usePwaInstall";
import InstallBanner from "./InstallBanner";
import IosInstallModal from "./IosInstallModal";

const PwaInstallContext = createContext(null);

export function usePwaInstallContext() {
  const ctx = useContext(PwaInstallContext);
  // Non-provider usage: return safe no-op defaults so the Header button
  // simply hides itself (isInstalled=true short-circuits).
  if (!ctx)
    return {
      canInstall: false,
      isIos: false,
      isInstalled: true,
      promptInstall: () => {},
      openIosModal: () => {},
    };
  return ctx;
}

export default function PwaInstallProvider({ children }) {
  const install = usePwaInstall();
  const [iosModalOpen, setIosModalOpen] = useState(false);

  // Auto-hide banner when install completes / standalone mode flips on.
  useEffect(() => {
    if (install.isInstalled) setIosModalOpen(false);
  }, [install.isInstalled]);

  const openIosModal = () => setIosModalOpen(true);
  const closeIosModal = () => setIosModalOpen(false);

  const value = useMemo(
    () => ({
      canInstall: install.canInstall,
      isIos: install.isIos,
      isInstalled: install.isInstalled,
      promptInstall: install.promptInstall,
      openIosModal,
    }),
    [install.canInstall, install.isIos, install.isInstalled, install.promptInstall]
  );

  // Banner visibility rules:
  // - not installed
  // - user hasn't dismissed
  // - either Chrome fired the event, or we're on iOS (manual guide path)
  const showBanner =
    !install.isInstalled &&
    !install.bannerDismissed &&
    (install.canInstall || install.isIos);

  return (
    <PwaInstallContext.Provider value={value}>
      {children}
      <InstallBanner
        open={showBanner}
        isIos={install.isIos}
        onInstall={install.promptInstall}
        onIosRequest={openIosModal}
        onDismiss={install.dismissBanner}
      />
      <IosInstallModal open={iosModalOpen} onClose={closeIosModal} />
    </PwaInstallContext.Provider>
  );
}
