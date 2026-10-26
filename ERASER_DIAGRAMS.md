# LASUSTECH Computer-Based Testing (CBT) System
# Complete Architecture & Presentation Diagrams for Eraser.io

> **How to use in Eraser.io**:
> 1. Open [Eraser.io](https://app.eraser.io) and create a new canvas or document.
> 2. **Option A (Instant Diagram-as-Code)**: Click **Insert > Diagram-as-Code** (or press `/diagram`), select the diagram type, and paste the code block directly.
> 3. **Option B (Mermaid Import)**: In Eraser, choose **Insert > Mermaid**, and paste any of the Mermaid blocks below. Eraser will instantly render interactive, customizable visual diagrams with colors, icons, and layout nodes.

---

## 1. System High-Level Architecture (Eraser Diagram-as-Code)

Copy and paste this into an **Eraser.io Architecture Diagram**:

```eraser
// LASUSTECH CBT System Architecture
direction right

Users [icon: users, color: blue] {
  Student [icon: user, label: "Student Candidate"]
  Lecturer [icon: graduation-cap, label: "Course Lecturer"]
  Admin [icon: shield, label: "Chief Invigilator / Admin"]
}

Frontend [icon: layout, color: purple] {
  NextApp [icon: globe, label: "Next.js 16 Web Application\n(Port 3000 • SSR & Turbopack)"]
  ExamRoom [icon: monitor, label: "Live CBT Room\n(Floating Video & Calc)"]
  LiveMonitor [icon: eye, label: "Invigilator Console\n(Multi-Density Grid)"]
}

BackendServices [icon: server, color: green] {
  RestApi [icon: code, label: "Public REST API Gateway\n(Port 3001 • Express & Zod)"]
  WebSocketEngine [icon: radio, label: "Realtime WebSocket Engine\n(Port 3002 • Socket.IO)"]
  QueueWorker [icon: cpu, label: "Background Queue Worker\n(Port 3003 • BullMQ)"]
}

DataLayer [icon: database, color: amber] {
  PostgreSQL [icon: database, label: "PostgreSQL 16 DB\n(Prisma ORM • Connection Pool)"]
  Redis [icon: layers, label: "Redis 7 In-Memory\n(Pub/Sub • BullMQ • Rate Limiter)"]
}

ExternalAI [icon: cloud, color: rose] {
  Gemini [icon: zap, label: "Google Gemini 2.5 Flash\n(Question Extraction & SVG)"]
  STUN [icon: broadcast, label: "Google STUN Server\n(WebRTC NAT Discovery)"]
}

// Relationships & Data Flows
Student > NextApp: Access CBT Portal
Lecturer > NextApp: Author Questions
Admin > NextApp: Manage Schedule

NextApp > RestApi: HTTPS / REST (JWT Bearer)
NextApp > WebSocketEngine: WSS (Realtime Events)

ExamRoom > WebSocketEngine: Camera Frames (every 3.5s)
ExamRoom > STUN: P2P ICE Traversal
LiveMonitor > WebSocketEngine: Proctor Interventions & Feeds

RestApi > PostgreSQL: Query / Mutate (Prisma)
RestApi > Redis: L7 Rate Limiting & Auth Tokens
WebSocketEngine > Redis: Multi-node Pub/Sub
QueueWorker > Redis: BullMQ Job Queue
QueueWorker > Gemini: Batch AI Extraction (10 Qs)
QueueWorker > PostgreSQL: Persist Questions & Media
```

---

## 2. End-to-End System Architecture (Mermaid Flowchart)

Copy and paste this into an **Eraser.io Mermaid Block**:

```mermaid
flowchart TB
    subgraph CLIENT_TIER["Client Layer (Web Browsers)"]
        S["Student Candidate<br/>(CBT Exam Room)"]
        L["Course Lecturer<br/>(Question Authoring)"]
        A["Chief Invigilator / Admin<br/>(Live Proctoring Console)"]
    end

    subgraph PRESENTATION_TIER["Frontend Application Layer (Port 3000)"]
        NEXT["Next.js 16 App Router<br/>(Turbopack, SSR, React 19)"]
        CALC["Built-in Scientific Calculator<br/>(Keyboard Inputs & Auto-Bracket Trig)"]
        CAM["Floating Video Feed<br/>(Offscreen Canvas + WebRTC)"]
        NEXT --- CALC
        NEXT --- CAM
    end

    subgraph API_TIER["Microservice Backend Layer (Supervisor Engine)"]
        API["Public REST API Gateway (Port 3001)<br/>• Express + Zod Validation<br/>• RBAC Guard (Admin, Lecturer, Student)<br/>• Layer-7 IP & User Rate Limiter"]
        WS["Realtime WebSocket Engine (Port 3002)<br/>• Socket.IO Server<br/>• Room Channeling (:staff & candidate)<br/>• WebRTC Signaling Relay"]
        WORKER["Background Queue Worker (Port 3003)<br/>• BullMQ Job Processor<br/>• 10-Question Batch Chunker<br/>• SVG High-Res Diagram Generator"]
    end

    subgraph DATA_TIER["Data & Cache Layer (Docker Infrastructure)"]
        PG[("PostgreSQL 16 Database<br/>• Users & RBAC Permissions<br/>• Questions, Options & Media<br/>• Sittings, Attempts & Answers<br/>• Audit Trail Logs")]
        REDIS[("Redis 7 In-Memory Store<br/>• BullMQ Task Queues<br/>• Multi-Server Pub/Sub Broadcast<br/>• Sliding Session Store<br/>• Rate Limiting Buckets")]
    end

    subgraph EXTERNAL_TIER["External Cloud Services"]
        AI["Google Gemini 2.5 Flash API<br/>(Structured JSON Extraction)"]
        STUN["Google STUN (stun:stun.l.google.com)<br/>(P2P WebRTC ICE Negotiation)"]
    end

    %% Connections
    S -->|HTTPS / WSS| NEXT
    L -->|HTTPS| NEXT
    A -->|HTTPS / WSS| NEXT

    NEXT -->|REST API Calls| API
    NEXT -->|WebSocket Stream| WS

    API -->|Prisma Client| PG
    API -->|Cache & Rate Limit| REDIS
    API -->|Enqueue Import Job| REDIS

    WS -->|Pub/Sub Relay| REDIS
    CAM -.->|P2P Video Feed| STUN

    REDIS -->|De-queue Jobs| WORKER
    WORKER -->|Prompt & Extract| AI
    WORKER -->|Store Extracted Questions| PG
```

---

## 3. Student Candidate CBT Exam Lifecycle (Mermaid Flowchart)

Copy and paste this into an **Eraser.io Mermaid Block**:

```mermaid
flowchart TD
    START([Candidate Opens CBT Portal]) --> LOGIN[Authenticate with Matric No / Email & Password]
    LOGIN --> VERIFY_ROLE{Valid Role?}
    VERIFY_ROLE -- No --> DENY[401 Unauthorized / Account Locked 423]
    VERIFY_ROLE -- Yes --> DASHBOARD[Student Dashboard]

    DASHBOARD --> ENROLL_GUARD{Is Candidate Enrolled<br/>in Course?}
    ENROLL_GUARD -- No --> HIDE[Exam Hidden from Dashboard]
    ENROLL_GUARD -- Yes --> VIEW_SCHEDULE[View Upcoming Exam Sitting]

    VIEW_SCHEDULE --> START_BTN[Click 'Start Exam']
    START_BTN --> TIME_GUARD{Within Scheduled<br/>Sitting Window?}
    TIME_GUARD -- Not Started --> LOCK_EARLY[409 SITTING_NOT_STARTED]
    TIME_GUARD -- Elapsed --> LOCK_LATE[409 SITTING_CLOSED]
    TIME_GUARD -- Active Window --> ENTER_CODE[Enter 6-Digit Sitting Access Code]

    ENTER_CODE --> CODE_CHECK{Access Code Valid?}
    CODE_CHECK -- Invalid --> CODE_ERR[Increment Failures / Lock After 5 Tries]
    CODE_CHECK -- Valid --> CAM_PROMPT[Request Camera Permission]

    CAM_PROMPT --> CAM_CHECK{Camera Permitted?}
    CAM_CHECK -- Denied --> WARN_FLAG[Flag Candidate & Log Camera Obstruction]
    CAM_CHECK -- Allowed --> ENTER_ROOM[Enter Exam Room Interface]

    subgraph EXAM_ROOM["Active Examination Session"]
        TIMER[Live Countdown Synchronized Timer]
        QUESTIONS[Question Palette & Navigation]
        CALCULATOR[Scientific Calculator with Physical Keypad]
        PICTURE[Floating Webcam Viewport]
        
        AUTOSAVE[Auto-Save Answer on Click]
        SNAPSHOT[Periodic Frame Snapshot to Socket every 3.5s]
        HEARTBEAT[Heartbeat & Anti-Cheat Event Telemetry]
    end

    ENTER_ROOM --> EXAM_ROOM
    EXAM_ROOM --> SUBMIT_TRIGGER{Submit Trigger?}
    
    SUBMIT_TRIGGER -- Manual Click --> CONFIRM_MODAL[Confirmation Modal: Answered vs Unanswered]
    SUBMIT_TRIGGER -- Timer Expired --> AUTO_SUBMIT[Deterministic Auto-Submit Engine]
    SUBMIT_TRIGGER -- Proctor Ejected --> MALPRACTICE_SUBMIT[Terminated by Invigilator]

    CONFIRM_MODAL --> GRADE[Deterministic Auto-Grading & Scoring]
    AUTO_SUBMIT --> GRADE
    MALPRACTICE_SUBMIT --> GRADE

    GRADE --> STATUS_UPDATE[Update Attempt Status to SUBMITTED]
    STATUS_UPDATE --> RESULT_CHECK{Admin Released Results?}
    RESULT_CHECK -- Pending Conclusion --> PENDING_MSG[Display 'Results Pending Release']
    RESULT_CHECK -- Concluded & Released --> TRANSCRIPT[View Official Result Slip & Transcript]
```

---

## 4. Dual-Tier Live Video Proctoring & WebRTC Signaling (Eraser Sequence Diagram)

Copy and paste this into an **Eraser.io Sequence Diagram**:

```eraser
// Dual-Tier Video Proctoring Sequence Flow
title Dual-Tier Video Proctoring & Real-Time Monitoring Flow

Candidate [icon: user, label: "Candidate (Browser)"]
SocketServer [icon: radio, label: "WebSocket Engine (:3002)"]
AdminConsole [icon: shield, label: "Invigilator Console"]
GoogleSTUN [icon: broadcast, label: "Google STUN Server"]

// Sitting Room Initialization
AdminConsole > SocketServer: join_sitting(sittingId) [Privileged Staff Room]
Candidate > SocketServer: join_sitting(sittingId) [Candidate Room]

// Tier 1: Continuous Frame Snapshot Stream (Multi-Density Grid)
loop Every 3.5 Seconds
  Candidate > Candidate: Draw video frame to 160x120 Canvas
  Candidate > SocketServer: emit("camera_frame", { sittingId, studentId, frame })
  SocketServer > AdminConsole: emit("candidate_camera_frame", { studentId, frame, ts })
  AdminConsole > AdminConsole: Update CandidateCard video thumbnail & LIVE badge
end

// Tier 2: Invigilator Candidate Inspection & WebRTC P2P Stream
AdminConsole > AdminConsole: Invigilator clicks "Inspect Candidate"
AdminConsole > SocketServer: emit("request_live_feed", { sittingId, studentId, invigilatorSocketId })
SocketServer > Candidate: emit("request_live_feed", { invigilatorSocketId })

Candidate > GoogleSTUN: Request ICE Candidates (NAT Discovery)
Candidate > SocketServer: emit("webrtc_signal", { sdp: Offer, targetSocketId })
SocketServer > AdminConsole: emit("webrtc_signal", { sdp: Offer, senderSocketId })

AdminConsole > GoogleSTUN: Request ICE Candidates
AdminConsole > SocketServer: emit("webrtc_signal", { sdp: Answer, targetSocketId })
SocketServer > Candidate: emit("webrtc_signal", { sdp: Answer, senderSocketId })

Candidate > AdminConsole: Direct P2P Video Track Stream (30 FPS WebRTC)
note over AdminConsole: If P2P negotiates: render 30 FPS video.\nIf firewall delays: fallback to Tier 1 snapshot.

// Mid-Exam Interventions
AdminConsole > SocketServer: emit("sitting.broadcast", { message: "10 mins remaining!" })
SocketServer > Candidate: emit("sitting.broadcast", { message })
Candidate > Candidate: Display Modal Alert Pop-up on Student Interface
```

---

## 5. Lecturer AI Question Bank & SVG Generation Pipeline (Mermaid Flowchart)

Copy and paste this into an **Eraser.io Mermaid Block**:

```mermaid
flowchart LR
    subgraph INPUT["Document Ingestion"]
        DOC["Exam File Upload<br/>(PDF, DOCX, TXT)"]
        LEC["Course Lecturer"]
        LEC -->|Uploads via Web UI| DOC
    end

    subgraph QUEUE_INGESTION["Asynchronous Queue Tier"]
        API["REST API Endpoint<br/>/api/v1/lecturer/import"]
        BULLMQ[("BullMQ Redis Queue<br/>Job: 'extract-questions'")]
        DOC --> API
        API -->|Enqueue File Path| BULLMQ
    end

    subgraph WORKER_PROCESSING["Background Worker Execution"]
        WORKER["Worker Process (:3003)"]
        PARSE["Text & Table Extractor"]
        CHUNK["Batch Partitioner<br/>(Strict 10-Question Windows)"]
        
        BULLMQ --> WORKER
        WORKER --> PARSE
        PARSE --> CHUNK
    end

    subgraph AI_PIPELINE["Gemini AI Processing"]
        GEMINI["Google Gemini 2.5 Flash<br/>(Structured Output Schema)"]
        JSON_PARSER["Resilient JSON Recovery Parser<br/>(Auto-Repairs Truncated AI Outputs)"]
        SVG_GEN["High-Resolution SVG Generator<br/>(Charts, Graphs & Geometry)"]
        
        CHUNK -->|Batch 1 (Q1-Q10)| GEMINI
        CHUNK -->|Batch 2 (Q11-Q20)| GEMINI
        GEMINI --> JSON_PARSER
        JSON_PARSER --> SVG_GEN
    end

    subgraph PERSISTENCE["Database & Question Bank"]
        DB[("PostgreSQL Database<br/>• Question Version<br/>• Options (A, B, C, D)<br/>• Stem Media (SVG)")]
        PREVIEW["Lecturer Review Studio<br/>• Live SVG Rendering<br/>• Inline Question Editor<br/>• One-Click Approval"]
        
        SVG_GEN --> DB
        DB --> PREVIEW
    end
```

---

## 6. Single-Reviewer Malpractice Incident Resolution (Mermaid Flowchart)

Copy and paste this into an **Eraser.io Mermaid Block**:

```mermaid
flowchart TD
    DETECT["Detection Event:<br/>• Webcam Obstruction<br/>• Multiple Faces Detected<br/>• Fullscreen Exit / Tab Switch<br/>• Physical Invigilator Observation"]
    
    DETECT --> LOG["Incident Docket Created in PostgreSQL<br/>(Severity: HIGH, Evidence Snapshot Stored)"]
    LOG --> ADMIN_VIEW["Admin Live Monitoring Console / Incidents Docket"]
    
    ADMIN_VIEW --> REVIEWER{"Single-Reviewer Action<br/>(No Senate Delays)"}
    
    REVIEWER -- "False Positive / Minor Anomaly" --> DISMISS["Dismiss Incident<br/>(Status: RESOLVED_DISMISSED)"]
    DISMISS --> KEEP_RESULT["Candidate Result Remains Normal<br/>(Status: VALID)"]

    REVIEWER -- "Confirmed Malpractice" --> CONFIRM["Confirm Malpractice<br/>(Status: RESOLVED_SANCTIONED)"]
    CONFIRM --> WITHHOLD["Auto-Withhold Candidate Attempt<br/>(Result Status: MALPRACTICE_HELD)"]
    
    WITHHOLD --> AUDIT_LOG["Cryptographic Audit Trail Logged<br/>(Actor, Timestamp, Action, IP Address)"]
    WITHHOLD --> TRANSCRIPT_BLOCK["Transcript Displays: 'WITHHELD'<br/>(Grade Omitted, Score Nullified)"]
```

---

## 7. Complete Entity-Relationship Diagram (ERD) (Mermaid erDiagram)

Copy and paste this into an **Eraser.io Mermaid Block**:

```mermaid
erDiagram
    USERS ||--o{ USER_ROLES : has
    ROLES ||--o{ USER_ROLES : defines
    USERS ||--o{ ENROLLMENTS : takes
    COURSES ||--o{ ENROLLMENTS : includes
    COURSES ||--o{ EXAMS : belongs_to
    EXAMS ||--o{ SITTINGS : scheduled_as
    SITTINGS ||--o{ SITTING_STUDENTS : admits
    USERS ||--o{ SITTING_STUDENTS : seated_for
    SITTINGS ||--o{ ATTEMPTS : generates
    USERS ||--o{ ATTEMPTS : executes
    EXAMS ||--o{ SECTIONS : contains
    SECTIONS ||--o{ QUESTIONS : organizes
    QUESTIONS ||--o{ QUESTION_VERSIONS : revisions
    QUESTION_VERSIONS ||--o{ OPTIONS : offers
    ATTEMPTS ||--o{ ANSWERS : records
    ATTEMPTS ||--o{ RESULTS : graded_as
    ATTEMPTS ||--o{ INCIDENTS : flags

    USERS {
        uuid id PK
        string email UK
        string matricNo UK
        string staffId UK
        string names
        enum status "ACTIVE, LOCKED, SUSPENDED"
        int failedLoginCount
        datetime lockedUntil
    }

    COURSES {
        uuid id PK
        string code UK
        string title
        int level
        int units
        uuid departmentId FK
    }

    EXAMS {
        uuid id PK
        string title
        enum kind "INTERNAL, PUBLIC"
        enum status "DRAFT, APPROVED, LOCKED"
        int durationMin
        uuid courseId FK
        uuid sessionId FK
    }

    SITTINGS {
        uuid id PK
        uuid examId FK
        uuid venueId FK
        datetime startsAt
        datetime endsAt
        enum status "SCHEDULED, OPEN, CLOSED, CANCELLED"
        string accessCode
        boolean requireWebcam
    }

    ATTEMPTS {
        uuid id PK
        uuid sittingId FK
        uuid studentId FK
        enum status "IN_PROGRESS, SUBMITTED, TERMINATED"
        datetime startedAt
        datetime submittedAt
        int flagsCount
    }

    ANSWERS {
        uuid id PK
        uuid attemptId FK
        uuid questionId FK
        uuid optionId FK
        boolean isCorrect
        float marksAwarded
    }

    RESULTS {
        uuid id PK
        uuid attemptId FK
        float totalScore
        float maxScore
        float percent
        string grade
        enum status "DRAFT, APPROVED, RELEASED, MALPRACTICE_HELD"
        boolean isCurrent
    }

    INCIDENTS {
        uuid id PK
        uuid attemptId FK
        enum category "MALPRACTICE, TECHNICAL, DISTURBANCE"
        enum severity "INFO, WARNING, HIGH"
        enum resolution "DISMISSED, SANCTIONED, PENDING"
        uuid reviewerId FK
    }
```
