/* Minimal preload. The dashboard is the agent-served web app and needs no
   privileged bridge, so we expose nothing — contextIsolation + sandbox stay on.
   This file exists as the documented seam for any future IPC (e.g. a native
   "pick workspace" menu item driving the running agent). */
'use strict';
// Intentionally empty.
