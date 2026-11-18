# Repeated message observations

The optional exported `createRepeatDetector` is a local bounded cache, not moderation
or a transport filter. Consumers supply a stable event ID, room/connection scope,
sender identity, text, and optionally an exact non-text variant discriminator
(e.g. emote IDs or reply context). No raw event is mutated or suppressed.

Exact matching is default. Normalized matches NFC, case and collapsed whitespace;
near matching additionally allows one insertion/deletion/substitution on plain
text of 16–512 UTF-16 units, against the group's original text, scanning at most
64 recent groups. Variant-bearing messages remain exact. Near matching is
approximate, not semantic equivalence.

The default inactivity window is 15 seconds, default cache bound 1024 groups
and recent IDs; each group also caps occurrences at that bound. Counts describe
the current burst, not all historical occurrences. Sender scope defaults to
one author; channel scope counts distinct author keys in the same room.
`observe(input, isActive)` lets a visual consumer start a new burst when a
representative has expired. `forget` drops a group, `clear` resets all state.
Use local receipt time, not untrusted upstream timestamps.
