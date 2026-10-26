# LASUSTECH Computer-Based Testing (CBT) System
# Eraser.io Presentation Diagrams & Architecture Flows

Copy and paste these blocks directly into [Eraser.io](https://app.eraser.io). They match your exact style with Portals on the left, Services in the center with labeled curved arrows, and Storage/External Services on the right.

---

## 1. System Architecture (All Services & Infrastructure)

> **In Eraser.io**: Create a new diagram, select **Diagram-as-Code**, and paste this exact code:

```eraser
// LASUSTECH CBT - System Architecture
direction right

PORTALS [icon: layout, color: blue] {
  Student App [icon: smartphone, label: "Student App\n(CBT Room & Video)"]
  Lecturer Portal [icon: monitor, label: "Lecturer Portal\n(Authoring & Bank)"]
  Admin Portal [icon: shield, label: "Admin Console\n(Live Proctor & Schedule)"]
}

CBT CORE ENGINE [icon: server, color: purple] {
  Auth & Security Guard [icon: lock, label: "Auth & RBAC Guard\n(JWT, Rate Limiter)"]
  Schedule & Sitting Service [icon: calendar, label: "Schedule & Sitting Service\n(Access Codes & Attendance)"]
  Assessment & Grading Service [icon: check-circle, label: "Assessment & Scoring\n(Order-Independent Grading)"]
  Live Proctoring Engine [icon: video, label: "Live Proctoring Engine\n(Socket.IO & WebRTC Relay)"]
  AI Question Ingestion Service [icon: cpu, label: "AI Question Ingestion\n(10-Item Batching)"]
  Incident & Malpractice Service [icon: alert-triangle, label: "Incident Resolution\n(Single-Person Result Hold)"]
}

STORAGE & INFRASTRUCTURE [icon: database, color: green] {
  PostgreSQL DB [icon: database, label: "PostgreSQL 16\n(Prisma ORM • Connection Pool)"]
  Redis In-Memory [icon: layers, label: "Redis 7\n(BullMQ & Socket Pub/Sub)"]
  Cloudflare R2 [icon: folder, label: "Cloudflare R2 / Media\n(High-Res SVG Diagrams)"]
}

EXTERNAL CLOUD [icon: cloud, color: amber] {
  Google Gemini AI [icon: zap, label: "Google Gemini 2.5 Flash\n(Question Extraction API)"]
  Google STUN Server [icon: radio, label: "Google STUN\n(WebRTC P2P NAT)"]
}

// Student Flows
PORTALS.Student App > CBT CORE ENGINE.Auth & Security Guard: Authenticate matric / email
PORTALS.Student App > CBT CORE ENGINE.Schedule & Sitting Service: Verify enrollment & enter access code
PORTALS.Student App > CBT CORE ENGINE.Live Proctoring Engine: Stream webcam snapshot (every 3.5s)
PORTALS.Student App > CBT CORE ENGINE.Assessment & Grading Service: Auto-save answers & submit paper

// Lecturer Flows
PORTALS.Lecturer Portal > CBT CORE ENGINE.AI Question Ingestion Service: Upload PDF / DOCX exam questions
PORTALS.Lecturer Portal > CBT CORE ENGINE.Assessment & Grading Service: View departmental results broadsheet

// Admin Flows
PORTALS.Admin Portal > CBT CORE ENGINE.Schedule & Sitting Service: Schedule sittings & print attendance register
PORTALS.Admin Portal > CBT CORE ENGINE.Live Proctoring Engine: Multi-density video grid (40-80 students)
PORTALS.Admin Portal > CBT CORE ENGINE.Incident & Malpractice Service: 1-Click malpractice hold (MALPRACTICE_HELD)

// Core to Storage Connections
CBT CORE ENGINE.Schedule & Sitting Service > STORAGE & INFRASTRUCTURE.PostgreSQL DB: Sittings & candidate attendance
CBT CORE ENGINE.Assessment & Grading Service > STORAGE & INFRASTRUCTURE.PostgreSQL DB: Store attempts & student scores
CBT CORE ENGINE.Live Proctoring Engine > STORAGE & INFRASTRUCTURE.Redis In-Memory: Pub/Sub broadcast across rooms
CBT CORE ENGINE.AI Question Ingestion Service > STORAGE & INFRASTRUCTURE.Redis In-Memory: BullMQ async processing queue
CBT CORE ENGINE.AI Question Ingestion Service > STORAGE & INFRASTRUCTURE.Cloudflare R2: Store generated SVG diagrams

// Core to External AI
CBT CORE ENGINE.AI Question Ingestion Service > EXTERNAL CLOUD.Google Gemini AI: Batch 10-Q JSON extraction
CBT CORE ENGINE.Live Proctoring Engine > EXTERNAL CLOUD.Google STUN Server: WebRTC P2P NAT discovery
```

---

## 2. Student CBT Exam Workflow (From Login to Live Video & Submission)

> **In Eraser.io**: Create a new diagram, select **Diagram-as-Code**, and paste:

```eraser
// Student CBT Examination Journey
direction right

CANDIDATE ACTIONS [icon: user, color: blue] {
  Login Step [icon: lock, label: "1. Student Login\n(Matric No & Password)"]
  Verification Step [icon: key, label: "2. Sitting Access Code\n(6-Digit Unlock Code)"]
  Webcam Step [icon: camera, label: "3. Camera Consent\n(Allow Browser Webcam)"]
  Active Exam Step [icon: monitor, label: "4. Live Exam Room\n(Floating Video & Calc)"]
  Submission Step [icon: check-square, label: "5. Submit Examination\n(Manual or Auto-Submit)"]
}

CBT SECURITY GUARDS [icon: shield, color: purple] {
  Enrollment Filter [icon: check, label: "Course Enrollment Guard\n(Only sees assigned courses)"]
  Schedule Window Guard [icon: clock, label: "Schedule Time Guard\n(No early/late access)"]
  Anti-Cheat Engine [icon: alert-circle, label: "Anti-Cheat Telemetry\n(Tab switch & Heartbeat)"]
  Deterministic Grader [icon: award, label: "Scoring Engine\n(Order-Independent Negative Marking)"]
}

OUTPUTS & RESULTS [icon: file-text, color: green] {
  Live Proctors [icon: eye, label: "Admin Live Monitor\n(Instant Video Thumbnail)"]
  Database Records [icon: database, label: "PostgreSQL Database\n(Answers & Attempt Logs)"]
  Result Slip [icon: file, label: "Official Result Portal\n(Concluded Exams Only)"]
}

// Student Lifecycle Connections
CANDIDATE ACTIONS.Login Step > CBT SECURITY GUARDS.Enrollment Filter: Verify course assignment
CBT SECURITY GUARDS.Enrollment Filter > CANDIDATE ACTIONS.Verification Step: Reveal scheduled sitting
CANDIDATE ACTIONS.Verification Step > CBT SECURITY GUARDS.Schedule Window Guard: Validate time window & code
CBT SECURITY GUARDS.Schedule Window Guard > CANDIDATE ACTIONS.Webcam Step: Trigger camera prompt
CANDIDATE ACTIONS.Webcam Step > CANDIDATE ACTIONS.Active Exam Step: Launch exam workspace

CANDIDATE ACTIONS.Active Exam Step > OUTPUTS & RESULTS.Live Proctors: Send video frame (every 3.5s)
CANDIDATE ACTIONS.Active Exam Step > CBT SECURITY GUARDS.Anti-Cheat Engine: Heartbeat every 15s
CANDIDATE ACTIONS.Active Exam Step > CANDIDATE ACTIONS.Submission Step: Finish exam or timer expire
CANDIDATE ACTIONS.Submission Step > CBT SECURITY GUARDS.Deterministic Grader: Auto-calculate raw score
CBT SECURITY GUARDS.Deterministic Grader > OUTPUTS & RESULTS.Database Records: Save submitted attempt
OUTPUTS & RESULTS.Database Records > OUTPUTS & RESULTS.Result Slip: Release upon exam conclusion
```

---

## 3. Lecturer AI Question Bank & SVG Generation Pipeline

> **In Eraser.io**: Create a new diagram, select **Diagram-as-Code**, and paste:

```eraser
// Lecturer AI Question Ingestion Pipeline
direction right

LECTURER PORTAL [icon: graduation-cap, color: blue] {
  Upload Interface [icon: upload, label: "Upload Document\n(PDF, Word DOCX, TXT)"]
  Question Studio [icon: edit-3, label: "Lecturer Review Studio\n(Edit Stem & Options)"]
  Question Bank [icon: book-open, label: "Approved Question Bank\n(Live in Exams)"]
}

PROCESSING QUEUE [icon: cpu, color: purple] {
  BullMQ Queue [icon: layers, label: "BullMQ Job Queue\n('extract-questions')"]
  Batch Chunker [icon: grid, label: "10-Question Partitioner\n(Token-Safe Windows)"]
  Resilient Parser [icon: refresh-cw, label: "Resilient JSON Repair\n(Fixes Truncated JSON)"]
  SVG Generator [icon: image, label: "High-Res SVG Generator\n(Charts, Graphs & Geometry)"]
}

EXTERNAL AI & DB [icon: cloud, color: amber] {
  Gemini 2.5 Flash [icon: zap, label: "Google Gemini 2.5 Flash\n(Structured Extraction)"]
  PostgreSQL Store [icon: database, label: "Question Versions Table\n(Stem, Options, Media)"]
}

// Pipeline Connections
LECTURER PORTAL.Upload Interface > PROCESSING QUEUE.BullMQ Queue: Enqueue file upload job
PROCESSING QUEUE.BullMQ Queue > PROCESSING QUEUE.Batch Chunker: Stream text & tables
PROCESSING QUEUE.Batch Chunker > EXTERNAL AI & DB.Gemini 2.5 Flash: Send 10-question chunk
EXTERNAL AI & DB.Gemini 2.5 Flash > PROCESSING QUEUE.Resilient Parser: Return structured JSON
PROCESSING QUEUE.Resilient Parser > PROCESSING QUEUE.SVG Generator: Generate SVG figures
PROCESSING QUEUE.SVG Generator > EXTERNAL AI & DB.PostgreSQL Store: Persist questions & media
EXTERNAL AI & DB.PostgreSQL Store > LECTURER PORTAL.Question Studio: Preview SVG & edit questions
LECTURER PORTAL.Question Studio > LECTURER PORTAL.Question Bank: Approve questions for examination
```

---

## 4. Admin Live Monitoring & Single-Reviewer Incident Resolution

> **In Eraser.io**: Create a new diagram, select **Diagram-as-Code**, and paste:

```eraser
// Admin Live Monitoring & Malpractice Resolution
direction right

PROCTOR CONSOLE [icon: shield, color: blue] {
  Grid Monitor [icon: grid, label: "Multi-Density Video Grid\n(Compact, Standard, Large)"]
  Candidate Inspector [icon: zoom-in, label: "Inspector Modal\n(WebRTC Video & Actions)"]
  Intervention Panel [icon: message-square, label: "Proctor Alerts\n(Broadcast & Messages)"]
}

INCIDENT ENGINE [icon: alert-triangle, color: purple] {
  Detection Triggers [icon: camera-off, label: "Automated Triggers\n(Obstruction, Tab Switch)"]
  Single Reviewer [icon: user-check, label: "Single-Person Review\n(Zero Senate Friction)"]
  Resolution Action [icon: slash, label: "Direct Decision\n(Dismiss or Hold)"]
}

EXAM OUTCOMES [icon: check-circle, color: green] {
  Normal Result [icon: file-text, label: "Valid Exam Result\n(Grade Computed)"]
  Withheld Result [icon: x-circle, label: "Result Withheld\n('MALPRACTICE_HELD')"]
  Audit Trail [icon: lock, label: "Cryptographic Audit Log\n(Reviewer ID & Timestamp)"]
}

// Flow Connections
PROCTOR CONSOLE.Grid Monitor > INCIDENT ENGINE.Detection Triggers: Suspicious candidate flagged
PROCTOR CONSOLE.Grid Monitor > PROCTOR CONSOLE.Candidate Inspector: Click candidate to inspect
PROCTOR CONSOLE.Candidate Inspector > PROCTOR CONSOLE.Intervention Panel: Send warning pop-up
INCIDENT ENGINE.Detection Triggers > INCIDENT ENGINE.Single Reviewer: Incident docket created
INCIDENT ENGINE.Single Reviewer > INCIDENT ENGINE.Resolution Action: Make instant final decision

INCIDENT ENGINE.Resolution Action > EXAM OUTCOMES.Normal Result: Dismiss incident (Clear flag)
INCIDENT ENGINE.Resolution Action > EXAM OUTCOMES.Withheld Result: Confirm malpractice (Hold score)
INCIDENT ENGINE.Resolution Action > EXAM OUTCOMES.Audit Trail: Record permanent audit log
```
