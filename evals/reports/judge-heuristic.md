# Judge calibration: heuristic vs human labels (24 items)

| metric | value |
|---|---|
| agreement | 0.71 |
| Cohen's kappa | 0.38 (need >= 0.6) |
| recall on human "fail" | 0.36 (need >= 0.8) |
| precision on "fail" | 1.00 |
| abstained | 0 |

|  | human fail | human pass |
|---|---|---|
| judge fail | 4 | 0 |
| judge pass | 7 | 13 |

Verdict: **not trusted**. Don't let it score drafts unattended; see disagreements below.

## Disagreements

| id | human | judge | human note | judge reason |
|---|---|---|---|---|
| j02 | fail | pass | wrong fact: link is valid 60 minutes | no red flags |
| j03 | fail | pass | wrong article: org accounts sign in via SSO | no red flags |
| j06 | fail | pass | claims an action support can't take | no red flags |
| j07 | fail | pass | wrong: past invoices can't be reissued with new details | no red flags |
| j10 | fail | pass | contradicts KB | no red flags |
| j12 | fail | pass | accurate text but ignores the actual problem (100% with no certificate) | no red flags |
| j16 | fail | pass | unhelpful; KB says use Report a problem | no red flags |
