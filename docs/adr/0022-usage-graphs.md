# 22. Usage graphs from Proxmox's own history

Date: 2026-11-09. Status: accepted. Item 4 of the first-release build order (`ROADMAP_FIRST_RELEASE.md` in the project notes), pulled forward by Rocky as low-hanging fruit.

## Decision

- **Source:** Proxmox's round-robin history, `rrddata` for a node or a guest, read with the person's own ticket (Sys.Audit for a node, VM.Audit for a guest). BossMox collects and stores nothing. Proxmox 9 keeps a point a minute for the last hour and day and one every 30 minutes for the last week; those are the three ranges offered: Last hour, Last day, Last week. Month and year exist in Proxmox but at coarse steps; left out for now.
- **Shaping, on the server (`src/usage.ts`):** oldest first, thinned to at most 120 points by averaging (a day's 1,440 minutes become 12-minute points), in plain units: processor as percent of all cores, memory in GB with the total, network in megabits a second (Proxmox keeps bytes; networks are spoken of in bits), guest disk activity in megabytes a second. A minute with no data stays empty, drawn as a gap, never as a drop to zero. Proxmox keeps no disk activity for a node, so nodes get three charts and guests four.
- **Where:** the Overview tab of a node and of a guest (not templates). One range choice, shared by both screens.
- **Charts:** one small chart per measure, each with its own scale (processor 0 to 100%, memory 0 to the total, network and disk to a round number above the peak), never two scales on one chart. Network and disk show two lines (in and out, read and write) with a legend that carries each line's current value. Hovering shows the time and each value. Each chart's screen-reader label says its current value and peak. Two dashed guide lines and a base line, no axis clutter; the start time and "Now" under each.
- **Colours:** two series colours per look, checked with the dataviz validator for colour-blind separation, lightness and contrast on that look's surface: Daylight `#0E7EA6`/`#eb6834`, Dusk `#3987e5`/`#d95926`, Workbench `#2747C4`/`#eb6834`. None of them are the warning or failure colours.
- **Refresh:** the screens around the charts redraw every 10 seconds, so the history is cached in the page per screen and range and fetched again at most once a minute.

## Not done

- A table view of the numbers. The screen redraws every 10 seconds, which would close an opened table; the hover values and each chart's spoken summary cover reading exact numbers for now.
- Storage usage over time and cluster-wide totals. Month and year ranges.
- Alerts on these numbers (item 5 of the build order).

## Tested

- Unit tests on real history saved from the test cluster (a node's full day, a guest's hour), each proven able to fail by breaking its rule: thinning to 120 points in time order whatever order Proxmox sends; units (percent, GB, megabits, megabytes); a gap stays empty and a bucket averages only what it has; a point without a time is dropped; a node's memory comes from its own field. That last test was added after breaking the memory field went unnoticed the first time.
- In a browser on the test BossMox: a node's Overview showed Processor, Memory and Network with current values; hovering showed the time and value; Last week drew 112 points from Nov 2 to now, with the line starting where the test node began recording; the charts and range survived the 10-second redraw; a running guest showed four charts. Checked in Daylight, Dusk and Workbench and at phone width (no sideways scroll). The first look caught legend swatches sitting apart from their labels and a week start label without a date; both fixed.
