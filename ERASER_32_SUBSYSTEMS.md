# LASUSTECH Computer-Based Testing (CBT) System
# Complete Architecture & Workflows for All 32 Sub-Systems

> **Eraser.io Usage Instructions**:
> 1. Open [Eraser.io](https://app.eraser.io) and create a new canvas or document.
> 2. Press `/diagram` or click **Insert > Diagram-as-Code**.
> 3. Paste any of the code blocks below into the left editor panel.
> 4. Eraser will generate the diagram matching your screenshots: Portals on the left, Core Services in the center with labeled curved arrows, and Data/Infrastructure on the right.

---

## 1. Master System Architecture (All 32 Sub-Systems)

```eraser
// LASUSTECH CBT - Complete 32 Subsystems Master Architecture
direction right

PORTALS [icon: layout, color: blue] {
  Student App [icon: smartphone, label: "1. Student CBT App\n(Exam Room & Video)"]
  Lecturer Portal [icon: monitor, label: "2. Lecturer Portal\n(Authoring & Blueprints)"]
  Admin Portal [icon: shield, label: "3. Admin Invigilator Console\n(Live Proctor & Schedule)"]
}

SECURITY & ACCESS MODULE [icon: lock, color: red] {
  Auth Service [icon: key, label: "4. Auth & Identity Service\n(Matric/Email/StaffId, JWT)"]
  RBAC Guard [icon: user-check, label: "5. RBAC & Scope Guard\n(Admin/Lecturer/Student)"]
  Rate Limiter [icon: shield, label: "6. Layer-7 Rate Limiter\n(Anti-Flood & Access Code Guard)"]
}

EXAM & ASSESSMENT ENGINE [icon: check-circle, color: purple] {
  Enrollment Guard [icon: book, label: "7. Course Enrollment Service\n(Departmental Strict Guard)"]
  Attempt Engine [icon: file-text, label: "8. Attempt & Paper Generator\n(Randomization & Resumption)"]
  AutoSave Service [icon: save, label: "9. Auto-Save & Telemetry\n(Debounced Save & 15s Heartbeat)"]
  Scoring Service [icon: award, label: "10. Deterministic Scoring Service\n(Order-Independent Grading)"]
  Script Review [icon: search, label: "11. Script Review Service\n(Post-Concluded Review)"]
}

LIVE PROCTORING ENGINE [icon: video, color: orange] {
  DualTier Video [icon: camera, label: "12. Dual-Tier Video Service\n(3.5s Snapshot & WebRTC)"]
  Intervention Service [icon: message-square, label: "13. Proctor Alerts Service\n(Modal Pop-ups & Broadcast)"]
  Malpractice Service [icon: alert-triangle, label: "14. Malpractice Resolution\n(Single-Reviewer Verdict)"]
}

LECTURER & QUESTION MODULE [icon: edit-3, color: cyan] {
  Question Bank [icon: book-open, label: "15. Question Authoring Service\n(State Boundaries & Schemes)"]
  SVG Generator [icon: image, label: "16. SVG Diagram Service\n(High-Res Charts & Graphs)"]
  Blueprint Service [icon: sliders, label: "17. Exam Blueprint Service\n(Quota, Passing Score, Approval)"]
  Media Delivery [icon: hard-drive, label: "18. Content Media Service\n(Immutable Caching)"]
}

ADMIN OPERATIONS MODULE [icon: settings, color: yellow] {
  Schedule Service [icon: calendar, label: "19. Schedule Builder Service\n(Room Capacity & Access Codes)"]
  Attendance Service [icon: printer, label: "20. Printable Attendance Service\n(Seating Docket & Sign-Off)"]
  Broadsheet Service [icon: share-2, label: "21. Results Broadsheet Service\n(Batch Release & Score Override)"]
  Structure Service [icon: git-merge, label: "22. University Structure Service\n(Colleges, Depts, Programmes)"]
  Sessions Service [icon: clock, label: "23. Academic Sessions Service\n(Dynamic Session Management)"]
  Audit Trail [icon: eye, label: "24. Cryptographic Audit Service\n(Tamper-Evident SHA Logging)"]
  Helpdesk Service [icon: help-circle, label: "25. Helpdesk & Support Service\n(Human Ref LASU-SUP-XXXXXX)"]
  Platform Controls [icon: power, label: "26. Platform Controls Service\n(Live Exam & Maintenance Mode)"]
}

BACKGROUND WORKER & AI [icon: cpu, color: pink] {
  Document Parser [icon: file-plus, label: "27. AI Document Parser\n(PDF/DOCX Text & Tables)"]
  Gemini Chunker [icon: zap, label: "28. 10-Question Batch Chunker\n(Gemini 2.5 Flash API)"]
  JSON Repair Engine [icon: refresh-cw, label: "29. Resilient JSON Parser\n(Auto-Fix Truncated JSON)"]
  Batch Scoring Queue [icon: list, label: "30. Batch Submission Worker\n(Auto-Submit on Timeout)"]
}

STORAGE & INFRASTRUCTURE [icon: database, color: green] {
  PostgreSQL DB [icon: database, label: "31. PostgreSQL 16 DB\n(Prisma ORM • Connection Pool)"]
  Redis In-Memory [icon: layers, label: "32. Redis 7 Store\n(BullMQ & Socket Pub/Sub)"]
  Cloud Media R2 [icon: folder, label: "Cloudflare R2 / Media\n(SVG Assets & Snapshots)"]
  Google STUN WebRTC [icon: radio, label: "Google STUN WebRTC\n(P2P NAT Traversal)"]
}

// Student Connections
PORTALS.Student App > SECURITY & ACCESS MODULE.Auth Service: 1. Login with Matric / Email
PORTALS.Student App > EXAM & ASSESSMENT ENGINE.Enrollment Guard: 2. Filter enrolled courses only
PORTALS.Student App > EXAM & ASSESSMENT ENGINE.Attempt Engine: 3. Start sitting with access code
PORTALS.Student App > LIVE PROCTORING ENGINE.DualTier Video: 4. Stream webcam frame (every 3.5s)
PORTALS.Student App > EXAM & ASSESSMENT ENGINE.AutoSave Service: 5. Auto-save answers & heartbeat
PORTALS.Student App > EXAM & ASSESSMENT ENGINE.Scoring Service: 6. Submit exam for auto-scoring
PORTALS.Student App > EXAM & ASSESSMENT ENGINE.Script Review: 7. Review script after conclusion

// Lecturer Connections
PORTALS.Lecturer Portal > LECTURER & QUESTION MODULE.Question Bank: Author & edit questions
PORTALS.Lecturer Portal > BACKGROUND WORKER & AI.Document Parser: Upload exam PDF / DOCX
PORTALS.Lecturer Portal > LECTURER & QUESTION MODULE.Blueprint Service: Set duration & pass marks
PORTALS.Lecturer Portal > ADMIN OPERATIONS MODULE.Broadsheet Service: View departmental results

// Admin Connections
PORTALS.Admin Portal > ADMIN OPERATIONS MODULE.Schedule Service: Schedule sittings & access codes
PORTALS.Admin Portal > ADMIN OPERATIONS MODULE.Attendance Service: Print official attendance register
PORTALS.Admin Portal > LIVE PROCTORING ENGINE.DualTier Video: Monitor multi-density video grid (40-80 candidates)
PORTALS.Admin Portal > LIVE PROCTORING ENGINE.Intervention Service: Send proctor popup & hall broadcast
PORTALS.Admin Portal > LIVE PROCTORING ENGINE.Malpractice Service: Single-click result hold (MALPRACTICE_HELD)
PORTALS.Admin Portal > ADMIN OPERATIONS MODULE.Broadsheet Service: Release batch results
PORTALS.Admin Portal > ADMIN OPERATIONS MODULE.Platform Controls: Toggle live exam / maintenance

// Inter-Module & AI Connections
BACKGROUND WORKER & AI.Document Parser > BACKGROUND WORKER & AI.Gemini Chunker: Extract text to 10-Q windows
BACKGROUND WORKER & AI.Gemini Chunker > BACKGROUND WORKER & AI.JSON Repair Engine: Parse structured questions
BACKGROUND WORKER & AI.JSON Repair Engine > LECTURER & QUESTION MODULE.SVG Generator: Generate vector charts
LIVE PROCTORING ENGINE.DualTier Video > STORAGE & INFRASTRUCTURE.Google STUN WebRTC: P2P candidate inspection

// Storage Connections
EXAM & ASSESSMENT ENGINE.Attempt Engine > STORAGE & INFRASTRUCTURE.PostgreSQL DB: Attempt papers & options
EXAM & ASSESSMENT ENGINE.Scoring Service > STORAGE & INFRASTRUCTURE.PostgreSQL DB: Calculate & persist grades
ADMIN OPERATIONS MODULE.Audit Trail > STORAGE & INFRASTRUCTURE.PostgreSQL DB: Immutable audit logs
BACKGROUND WORKER & AI.Batch Scoring Queue > STORAGE & INFRASTRUCTURE.Redis In-Memory: BullMQ async job queue
LIVE PROCTORING ENGINE.DualTier Video > STORAGE & INFRASTRUCTURE.Redis In-Memory: Pub/Sub broadcast frames
LECTURER & QUESTION MODULE.SVG Generator > STORAGE & INFRASTRUCTURE.Cloud Media R2: Content-addressed SVG storage
```

---

## 2. Examination Lifecycle Workflow (Student & Invigilator Sub-Systems)

```eraser
// Student CBT Examination Journey
direction right

CANDIDATE PORTAL [icon: user, color: blue] {
  Student Login [icon: lock, label: "1. Student Login\n(Matric No & Password)"]
  Access Code Entry [icon: key, label: "2. Sitting Unlock Code\n(6-Digit Secret)"]
  Webcam Permission [icon: camera, label: "3. Camera Consent\n(Allow Browser Webcam)"]
  CBT Exam Interface [icon: monitor, label: "4. Live CBT Exam Room\n(Palette, Timer, Calc)"]
  Exam Submission [icon: check-square, label: "5. Submit Examination\n(Manual or Auto-Timeout)"]
}

CORE ENFORCEMENT [icon: shield, color: purple] {
  Course Guard [icon: check, label: "7. Course Enrollment Service\n(Strict Curriculum Boundary)"]
  Schedule Guard [icon: clock, label: "19. Schedule Builder Service\n(Time Window Enforcement)"]
  AntiCheat Guard [icon: alert-circle, label: "9. Telemetry & Heartbeat\n(15s Ping & Focus Loss)"]
  Grading Guard [icon: award, label: "10. Deterministic Scoring\n(Order-Independent Scoring)"]
}

INVIGILATION & OUTCOMES [icon: eye, color: green] {
  Live Proctor [icon: video, label: "12. Multi-Density Video Grid\n(Compact/Standard/Large)"]
  Incident Action [icon: alert-triangle, label: "14. Single-Reviewer Verdict\n(Dismiss vs MALPRACTICE_HELD)"]
  Official Transcript [icon: file, label: "11. Script & Result Portal\n(Post-Concluded Release)"]
}

// Workflow Links
CANDIDATE PORTAL.Student Login > CORE ENFORCEMENT.Course Guard: Authenticate matriculation number
CORE ENFORCEMENT.Course Guard > CANDIDATE PORTAL.Access Code Entry: Filter only enrolled sittings
CANDIDATE PORTAL.Access Code Entry > CORE ENFORCEMENT.Schedule Guard: Validate active time window & code
CORE ENFORCEMENT.Schedule Guard > CANDIDATE PORTAL.Webcam Permission: Grant room entry
CANDIDATE PORTAL.Webcam Permission > CANDIDATE PORTAL.CBT Exam Interface: Launch active exam room

CANDIDATE PORTAL.CBT Exam Interface > INVIGILATION & OUTCOMES.Live Proctor: Send webcam frame (every 3.5s)
CANDIDATE PORTAL.CBT Exam Interface > CORE ENFORCEMENT.AntiCheat Guard: Stream candidate heartbeats
CORE ENFORCEMENT.AntiCheat Guard > INVIGILATION & OUTCOMES.Incident Action: Flag candidate if anomaly detected
CANDIDATE PORTAL.CBT Exam Interface > CANDIDATE PORTAL.Exam Submission: Finish exam or timer expire
CANDIDATE PORTAL.Exam Submission > CORE ENFORCEMENT.Grading Guard: Compute raw score & percentage
CORE ENFORCEMENT.Grading Guard > INVIGILATION & OUTCOMES.Official Transcript: Publish results upon exam conclusion
```

---

## 3. Asynchronous AI Question Ingestion & SVG Generation Pipeline

```eraser
// AI Question Ingestion & High-Res SVG Pipeline
direction right

LECTURER INPUT [icon: graduation-cap, color: blue] {
  Upload Step [icon: upload, label: "Upload Exam File\n(PDF, Word DOCX, TXT)"]
  Review Step [icon: edit-3, label: "Lecturer Studio\n(Edit Stem & Options)"]
  Approval Step [icon: check, label: "Approve for Exam\n(Move to Question Bank)"]
}

PROCESSING SUBSYSTEMS [icon: cpu, color: purple] {
  Parser Service [icon: file-text, label: "27. AI Document Parser\n(Text & Table Extractor)"]
  Batch Chunker [icon: grid, label: "28. 10-Question Batcher\n(Token-Safe Windows)"]
  JSON Engine [icon: refresh-cw, label: "29. Resilient JSON Engine\n(Auto-Repair Incomplete JSON)"]
  SVG Service [icon: image, label: "16. SVG Diagram Service\n(Charts, Graphs & Geometry)"]
}

INFRASTRUCTURE [icon: database, color: green] {
  Redis BullMQ [icon: layers, label: "32. BullMQ Queue\n('extract-questions')"]
  Gemini Cloud [icon: zap, label: "Google Gemini 2.5 Flash\n(Structured JSON API)"]
  PostgreSQL Table [icon: database, label: "31. Questions Database\n(Question Versions & Options)"]
}

// Pipeline Links
LECTURER INPUT.Upload Step > INFRASTRUCTURE.Redis BullMQ: Enqueue file upload job
INFRASTRUCTURE.Redis BullMQ > PROCESSING SUBSYSTEMS.Parser Service: De-queue and extract text
PROCESSING SUBSYSTEMS.Parser Service > PROCESSING SUBSYSTEMS.Batch Chunker: Segment into 10-Q batches
PROCESSING SUBSYSTEMS.Batch Chunker > INFRASTRUCTURE.Gemini Cloud: Request structured extraction
INFRASTRUCTURE.Gemini Cloud > PROCESSING SUBSYSTEMS.JSON Engine: Stream JSON payload
PROCESSING SUBSYSTEMS.JSON Engine > PROCESSING SUBSYSTEMS.SVG Service: Render vector diagrams
PROCESSING SUBSYSTEMS.SVG Service > INFRASTRUCTURE.PostgreSQL Table: Persist stem, options & media
INFRASTRUCTURE.PostgreSQL Table > LECTURER INPUT.Review Step: Display question & diagram preview
LECTURER INPUT.Review Step > LECTURER INPUT.Approval Step: Lock approved questions into bank
```

---

## 4. Live Proctoring & Single-Reviewer Malpractice Resolution Flow

```eraser
// Live Proctoring & Single-Reviewer Malpractice Resolution
direction right

DETECTION & PROCTORING [icon: shield, color: blue] {
  Video Grid [icon: grid, label: "12. Multi-Density Video Grid\n(Compact, Standard, Large)"]
  Inspector Modal [icon: zoom-in, label: "Candidate Inspector\n(Live Feed & Seat Controls)"]
  Hall Alerts [icon: message-square, label: "13. Proctor Alerts Service\n(Modal Warning Pop-ups)"]
}

SINGLE-REVIEWER INCIDENT CORE [icon: alert-triangle, color: purple] {
  Automated Flag [icon: camera-off, label: "Anomaly Detection\n(Obstruction, Tab Switch)"]
  Single Decision Maker [icon: user-check, label: "14. Single-Person Review\n(Zero Senate Delays)"]
  Verdict Dispatcher [icon: slash, label: "Decision Engine\n(Dismiss vs Sanction)"]
}

SYSTEM CONSEQUENCES [icon: lock, color: green] {
  Dismissed Case [icon: check-circle, label: "Clear Incident\n(Status: RESOLVED_DISMISSED)"]
  Withheld Result [icon: x-circle, label: "Hold Result\n(Status: MALPRACTICE_HELD)"]
  Audit Record [icon: eye, label: "24. Cryptographic Audit\n(Tamper-Evident SHA Log)"]
}

// Flow Links
DETECTION & PROCTORING.Video Grid > SINGLE-REVIEWER INCIDENT CORE.Automated Flag: Anomaly detected
DETECTION & PROCTORING.Video Grid > DETECTION & PROCTORING.Inspector Modal: Invigilator inspects student
DETECTION & PROCTORING.Inspector Modal > DETECTION & PROCTORING.Hall Alerts: Send direct student warning
SINGLE-REVIEWER INCIDENT CORE.Automated Flag > SINGLE-REVIEWER INCIDENT CORE.Single Decision Maker: Open incident docket
SINGLE-REVIEWER INCIDENT CORE.Single Decision Maker > SINGLE-REVIEWER INCIDENT CORE.Verdict Dispatcher: Choose instant action

SINGLE-REVIEWER INCIDENT CORE.Verdict Dispatcher > SYSTEM CONSEQUENCES.Dismissed Case: Dismiss as false alarm
SINGLE-REVIEWER INCIDENT CORE.Verdict Dispatcher > SYSTEM CONSEQUENCES.Withheld Result: Confirm malpractice & withhold score
SINGLE-REVIEWER INCIDENT CORE.Verdict Dispatcher > SYSTEM CONSEQUENCES.Audit Record: Write permanent audit record
```
