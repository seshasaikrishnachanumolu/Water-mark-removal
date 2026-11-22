import React, { Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Landing from "./Landing.jsx";
import DownloadPage from "./components/DownloadPage.jsx";
import "./index.css";

// The editor is a big chunk; load it only when its route is opened.
const EditorPage = lazy(() => import("./editor/EditorPage.jsx"));

// Tiny hash router:
//   #/studio -> watermark remover (unchanged)   #/editor -> Studio Editor   else -> landing
function Root() {
  const [route, setRoute] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => {
      setRoute(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (route === "#/editor") {
    return (
      <Suspense fallback={<div className="grid h-screen place-items-center bg-ed-bg text-ed-mute">Loading editor...</div>}>
        <EditorPage />
      </Suspense>
    );
  }
  if (route === "#/download") return <DownloadPage />;
  return route === "#/studio" ? <App /> : <Landing />;
}

createRoot(document.getElementById("root")).render(<Root />);
