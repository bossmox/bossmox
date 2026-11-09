# 21. Desktop icons people can arrange

Date: 2026-11-09. Status: accepted. Rocky: "let's add draggable icons on the desktop".

## Decision

- On a screen wider than a phone, each desktop icon can be dragged anywhere on the open desktop, left of the health panel. It snaps to a grid (110 by 124 px cells); dropping it on another icon swaps the two, so icons never overlap.
- The layout is kept per browser in local storage (`bossmox.icons`, app to column and row), like the look. It's a convenience: with storage blocked it lasts until the page closes, and a missing or odd value falls back to the default.
- The default is the old fixed grid: two columns, across then down, in the apps' fixed order. A saved spot that no longer fits (a smaller window) moves to the first free cell rather than off screen.
- A press that moves less than 6 px is a click and opens the app; a drag never opens it.
- Keyboard: Alt and an arrow key move the focused icon one cell, and tab order follows reading order (across each row, then down).
- Right-clicking the empty desktop shows **Line up icons**, which clears the saved layout.
- Phone width keeps the fixed grid with no dragging, since dragging there fights scrolling.

## Not done

Icons for single guests or shortcuts on the desktop. Shared layouts across browsers or people (would need the server, like ADR 0018's preferences); per-browser matches how the look is kept.

## Tested

In a browser on the test BossMox at 1440 by 900, with real mouse events: the default matched the old grid; dragging Backups moved only Backups, saved it, and opened nothing; dropping Virtual Machines on Storage swapped them; the layout survived a reload; Alt+Right moved Health check one cell and kept focus; a plain click on Create a VM still opened it; right-click showed Line up icons, which restored the default and cleared the saved layout. At phone width (390 px) the fixed grid returned with no positions and no sideways scroll. The first run caught a bug: the default followed the icons' page order, which the keyboard reordering changes, so icons reshuffled; it now follows the fixed app order.
