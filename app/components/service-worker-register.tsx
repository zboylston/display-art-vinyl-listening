"use client";

import { useEffect } from "react";

/** Registers the shell service worker once on the client. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        void registration.update();
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          // Pick up a newly activated worker after deploy (e.g. TV PWA).
          if (sessionStorage.getItem("nf-sw-reloaded") === "1") return;
          sessionStorage.setItem("nf-sw-reloaded", "1");
          window.location.reload();
        });
      })
      .catch(() => undefined);
  }, []);
  return null;
}
