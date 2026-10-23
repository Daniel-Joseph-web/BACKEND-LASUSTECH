/**
 * Seeds the LASUSTECH CBT database.
 *
 * Two things live here:
 *
 *  1. The institution's real structure — 5 colleges, 38 departments, 39 programmes
 *     and 48 courses — transcribed from `lasustech-cbt/lib/lasustech-structure.ts`,
 *     which until now was the only copy of it. That fixture carries no unit values,
 *     so every course is seeded at 3 units; correct them through
 *     `PATCH /admin/courses/:id` when the real load is known.
 *  2. The three demo logins the rest of the system is developed against —
 *     one per portal: admin, lecturer, student.
 *
 * Every write is an upsert, so this is safe to re-run against a populated
 * database — `prisma migrate reset` invokes it automatically after migrating.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const BCRYPT_ROUNDS = 12; // must match apps/api/src/modules/auth/auth.service.ts

/** Academic year the structure below is current for. */
const CURRENT_SESSION = '2026/2027';
const PREVIOUS_SESSION = '2025/2026';

/**
 * The institution has exactly three roles at every layer. Exam-office and
 * invigilation duties are capabilities of ADMIN/LECTURER, not separate
 * identities — see apps/api/src/modules/auth/tokens.ts.
 */
const ROLES = [
  { key: 'ADMIN', name: 'System Administrator' },
  { key: 'LECTURER', name: 'Lecturer' },
  { key: 'STUDENT', name: 'Student' },
];

const USERS = [
  { role: 'ADMIN', names: 'First Admin', email: 'admin@lasustech.edu.ng', staffId: 'ADMIN/001' },
  { role: 'LECTURER', names: 'Dr. Bello', email: 'bello@lasustech.edu.ng', staffId: 'STAFF/042' },
  { role: 'STUDENT', names: 'Nifemi Osadare', email: 'nifemi@cbt.lasustech.edu.ng', matricNo: 'CSC/2022/305' },
] as const;

/**
 * Demo accounts from before the role reduction. They are removed (or, when
 * audit history makes deletion impossible, deactivated) so a re-seed of an
 * older database also ends with exactly three roles.
 */
const LEGACY_DEMO_EMAILS = ['officer@lasustech.edu.ng', 'invigilator@lasustech.edu.ng'];

/**
 * The Nigerian 5-point scale. `Result.grade` is a `Grade` enum with no numbers
 * attached, so this table is the only place the cut-offs are written down.
 */
const GRADE_BANDS = [
  { grade: 'A', minPercent: 70, maxPercent: 100, point: 5, label: 'Excellent' },
  { grade: 'B', minPercent: 60, maxPercent: 69.99, point: 4, label: 'Very Good' },
  { grade: 'C', minPercent: 50, maxPercent: 59.99, point: 3, label: 'Good' },
  { grade: 'D', minPercent: 45, maxPercent: 49.99, point: 2, label: 'Fair' },
  { grade: 'E', minPercent: 40, maxPercent: 44.99, point: 1, label: 'Pass' },
  { grade: 'F', minPercent: 0, maxPercent: 39.99, point: 0, label: 'Fail' },
] as const;

type Sem = 'FIRST' | 'SECOND';

interface SeedCourse {
  code: string;
  title: string;
  level: number;
  sem: Sem;
  /** Names only. Matched against real lecturer accounts at the end of the seed. */
  lecturers: string[];
  active: boolean;
}

interface SeedProgramme {
  code: string;
  name: string;
  award: string;
  durationYears: number;
}

interface SeedDepartment {
  code: string;
  name: string;
  head: string;
  programmes: SeedProgramme[];
  courses: SeedCourse[];
}

interface SeedCollege {
  code: string;
  name: string;
  dean: string;
  departments: SeedDepartment[];
}

const FIRST = 'FIRST' as const;
const SECOND = 'SECOND' as const;

const STRUCTURE: SeedCollege[] = [
  {
    code: 'AGR',
    name: 'College of Agriculture',
    dean: 'Prof. K. A. Adeleke',
    departments: [
      {
        code: 'AEFM',
        name: 'Agricultural Economics and Farm Management',
        head: 'Dr. A. O. Oladipo',
        programmes: [
          { code: 'AEFM', name: 'B.Agric. Agricultural Economics & Farm Management', award: 'B.Agric.', durationYears: 5 },
        ],
        courses: [
          { code: 'AEF 201', title: 'Principles of Agricultural Economics', level: 200, sem: FIRST, lecturers: ['Dr. A. O. Oladipo'], active: true },
          { code: 'AEF 301', title: 'Farm Management and Accounting', level: 300, sem: FIRST, lecturers: ['Dr. A. O. Oladipo'], active: true },
        ],
      },
      {
        code: 'AERD',
        name: 'Agricultural Extension and Rural Development',
        head: 'Dr. (Mrs.) R. M. Sanni',
        programmes: [
          { code: 'AERD', name: 'B.Agric. Agricultural Extension & Rural Development', award: 'B.Agric.', durationYears: 5 },
        ],
        courses: [
          { code: 'AEX 201', title: 'Introduction to Agricultural Extension', level: 200, sem: FIRST, lecturers: ['Dr. R. M. Sanni'], active: true },
        ],
      },
      {
        code: 'ANP',
        name: 'Animal Production',
        head: 'Dr. B. E. Babalola',
        programmes: [
          { code: 'ANP', name: 'B.Agric. Animal Production', award: 'B.Agric.', durationYears: 5 },
        ],
        courses: [
          { code: 'ANP 201', title: 'Introduction to Animal Agriculture', level: 200, sem: FIRST, lecturers: ['Dr. B. E. Babalola'], active: true },
          { code: 'ANP 301', title: 'Ruminant Animal Management', level: 300, sem: FIRST, lecturers: ['Dr. B. E. Babalola'], active: true },
        ],
      },
      {
        code: 'CRP',
        name: 'Crop Protection',
        head: 'Dr. J. T. Alamu',
        programmes: [
          { code: 'CRP', name: 'B.Agric. Crop Protection', award: 'B.Agric.', durationYears: 5 },
        ],
        courses: [
          { code: 'CRP 201', title: 'Crop Anatomy and Physiology', level: 200, sem: FIRST, lecturers: ['Dr. J. T. Alamu'], active: true },
        ],
      },
      {
        code: 'FAQ',
        name: 'Fisheries and Aquaculture',
        head: 'Dr. M. K. Lawal',
        programmes: [
          { code: 'FAQ', name: 'B.Fisheries Fisheries and Aquaculture', award: 'B.Fisheries', durationYears: 5 },
        ],
        courses: [
          { code: 'FAQ 201', title: 'Principles of Aquaculture', level: 200, sem: FIRST, lecturers: ['Dr. M. K. Lawal'], active: true },
        ],
      },
      {
        code: 'HLM',
        name: 'Horticulture and Landscape Management',
        head: 'Dr. O. A. Ajayi',
        programmes: [
          { code: 'HLM', name: 'B.Agric. Horticulture & Landscape Management', award: 'B.Agric.', durationYears: 5 },
        ],
        courses: [
          { code: 'HLM 201', title: 'Introduction to Horticulture', level: 200, sem: FIRST, lecturers: ['Dr. O. A. Ajayi'], active: true },
        ],
      },
    ],
  },
  {
    code: 'CEDT',
    name: 'College of Environmental Design and Technology',
    dean: 'Prof. A. S. Mustapha',
    departments: [
      {
        code: 'ARC',
        name: 'Architecture',
        head: 'Arc. D. M. Shonibare',
        programmes: [
          { code: 'ARC', name: 'B.Sc. Architecture', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'ARC 201', title: 'Architectural Graphics I', level: 200, sem: FIRST, lecturers: ['Arc. D. M. Shonibare'], active: true },
          { code: 'ARC 301', title: 'Building Climatology', level: 300, sem: FIRST, lecturers: ['Arc. D. M. Shonibare'], active: true },
        ],
      },
      {
        code: 'AID',
        name: 'Art and Industrial Design',
        head: 'Dr. S. O. Ogundele',
        programmes: [
          { code: 'AID', name: 'B.A. Fine & Applied Arts / Industrial Design', award: 'B.A.', durationYears: 4 },
        ],
        courses: [
          { code: 'AID 201', title: 'Introduction to Industrial Design', level: 200, sem: FIRST, lecturers: ['Dr. S. O. Ogundele'], active: true },
        ],
      },
      {
        code: 'BLD',
        name: 'Building Technology',
        head: 'Bldr. E. O. Coker',
        programmes: [
          { code: 'BLD', name: 'B.Sc. Building Technology', award: 'B.Sc.', durationYears: 5 },
        ],
        courses: [
          { code: 'BLD 201', title: 'Building Construction I', level: 200, sem: FIRST, lecturers: ['Bldr. E. O. Coker'], active: true },
        ],
      },
      {
        code: 'EMV',
        name: 'Estate Management and Valuation',
        head: 'ESV. K. B. Williams',
        programmes: [
          { code: 'EMV', name: 'B.Sc. Estate Management & Valuation', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'EMV 201', title: 'Principles of Valuation I', level: 200, sem: FIRST, lecturers: ['ESV. K. B. Williams'], active: true },
        ],
      },
      {
        code: 'QSV',
        name: 'Quantity Surveying',
        head: 'QS. T. A. Badmus',
        programmes: [
          { code: 'QSV', name: 'B.Sc. Quantity Surveying', award: 'B.Sc.', durationYears: 5 },
        ],
        courses: [
          { code: 'QSV 201', title: 'Measurement of Building Works I', level: 200, sem: FIRST, lecturers: ['QS. T. A. Badmus'], active: true },
        ],
      },
      {
        code: 'URP',
        name: 'Urban and Regional Planning',
        head: 'Tpl. H. O. Balogun',
        programmes: [
          { code: 'URP', name: 'B.Sc. Urban & Regional Planning', award: 'B.Sc.', durationYears: 5 },
        ],
        courses: [
          { code: 'URP 201', title: 'Introduction to Town Planning', level: 200, sem: FIRST, lecturers: ['Tpl. H. O. Balogun'], active: true },
        ],
      },
    ],
  },
  {
    code: 'CASS',
    name: 'College of Applied Social Sciences',
    dean: 'Prof. M. B. Fashina',
    departments: [
      {
        code: 'ACC',
        name: 'Accounting',
        head: 'Dr. O. M. Tijani',
        programmes: [
          { code: 'ACC', name: 'B.Sc. Accounting', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'ACC 201', title: 'Financial Accounting I', level: 200, sem: FIRST, lecturers: ['Dr. O. M. Tijani'], active: true },
          { code: 'ACC 301', title: 'Management Accounting', level: 300, sem: FIRST, lecturers: ['Dr. O. M. Tijani'], active: true },
        ],
      },
      {
        code: 'BNF',
        name: 'Banking and Finance',
        head: 'Dr. A. L. Yusuf',
        programmes: [
          { code: 'BNF', name: 'B.Sc. Banking and Finance', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'BNF 201', title: 'Money and Banking', level: 200, sem: FIRST, lecturers: ['Dr. A. L. Yusuf'], active: true },
        ],
      },
      {
        code: 'BAD',
        name: 'Business Administration',
        head: 'Dr. F. K. Sanusi',
        programmes: [
          { code: 'BAD', name: 'B.Sc. Business Administration', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'BAD 201', title: 'Principles of Management', level: 200, sem: FIRST, lecturers: ['Dr. F. K. Sanusi'], active: true },
        ],
      },
      {
        code: 'ECO',
        name: 'Economics',
        head: 'Dr. I. O. Popoola',
        programmes: [
          { code: 'ECO', name: 'B.Sc. Economics', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'ECO 201', title: 'Microeconomic Theory I', level: 200, sem: FIRST, lecturers: ['Dr. I. O. Popoola'], active: true },
        ],
      },
      {
        code: 'HTM',
        name: 'Hospitality and Tourism Management',
        head: 'Dr. (Mrs.) Y. A. Bakare',
        programmes: [
          { code: 'HTM', name: 'B.Sc. Hospitality & Tourism Management', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'HTM 201', title: 'Introduction to Hospitality Management', level: 200, sem: FIRST, lecturers: ['Dr. Y. A. Bakare'], active: true },
        ],
      },
      {
        code: 'IAS',
        name: 'Insurance and Actuarial Science',
        head: 'Dr. T. G. Sowunmi',
        programmes: [
          { code: 'IAS', name: 'B.Sc. Insurance & Actuarial Science', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'IAS 201', title: 'Principles of Insurance', level: 200, sem: FIRST, lecturers: ['Dr. T. G. Sowunmi'], active: true },
        ],
      },
      {
        code: 'MKT',
        name: 'Marketing',
        head: 'Dr. R. O. Dosunmu',
        programmes: [
          { code: 'MKT', name: 'B.Sc. Marketing', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'MKT 201', title: 'Principles of Marketing', level: 200, sem: FIRST, lecturers: ['Dr. R. O. Dosunmu'], active: true },
        ],
      },
      {
        code: 'MAC',
        name: 'Mass Communication',
        head: 'Dr. G. A. Adegoke',
        programmes: [
          { code: 'MAC', name: 'B.Sc. Mass Communication', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'MAC 201', title: 'Introduction to Mass Communication', level: 200, sem: FIRST, lecturers: ['Dr. G. A. Adegoke'], active: true },
        ],
      },
      {
        code: 'OIM',
        name: 'Office and Information Management',
        head: 'Dr. (Mrs.) B. T. Olusanya',
        programmes: [
          { code: 'OIM', name: 'B.Sc. Office & Information Management', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'OIM 201', title: 'Office Administration & Practice', level: 200, sem: FIRST, lecturers: ['Dr. B. T. Olusanya'], active: true },
        ],
      },
    ],
  },
  {
    code: 'CBS',
    name: 'College of Basic Sciences',
    dean: 'Prof. O. Adebayo',
    departments: [
      {
        code: 'BCH',
        name: 'Biochemistry',
        head: 'Dr. S. K. Onasanya',
        programmes: [
          { code: 'BCH', name: 'B.Sc. Biochemistry', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'BCH 201', title: 'General Biochemistry I', level: 200, sem: FIRST, lecturers: ['Dr. S. K. Onasanya'], active: true },
        ],
      },
      {
        code: 'BOT',
        name: 'Botany',
        head: 'Dr. (Mrs.) C. N. Eze',
        programmes: [
          { code: 'BOT', name: 'B.Sc. Botany', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'BOT 201', title: 'Lower Plant Taxonomy', level: 200, sem: FIRST, lecturers: ['Dr. C. N. Eze'], active: true },
        ],
      },
      {
        code: 'CHM',
        name: 'Chemistry',
        head: 'Dr. P. A. Ogunsanya',
        programmes: [
          { code: 'CHM', name: 'B.Sc. Chemistry', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'CHM 101', title: 'General Physical Chemistry', level: 100, sem: FIRST, lecturers: ['Dr. P. A. Ogunsanya'], active: true },
          { code: 'CHM 201', title: 'Organic Chemistry I', level: 200, sem: FIRST, lecturers: ['Dr. P. A. Ogunsanya'], active: true },
        ],
      },
      {
        code: 'CSC',
        name: 'Computer Science',
        head: 'Dr. Adeyemi',
        programmes: [
          { code: 'CSC', name: 'B.Sc. Computer Science', award: 'B.Sc.', durationYears: 4 },
          { code: 'SEN', name: 'B.Sc. Software Engineering', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'CSC 101', title: 'Introduction to Computing', level: 100, sem: FIRST, lecturers: ['Dr. Adeyemi'], active: true },
          { code: 'CSC 201', title: 'Computer Programming I', level: 200, sem: FIRST, lecturers: ['Dr. Adeyemi'], active: true },
          { code: 'CSC 301', title: 'Data Structures & Algorithms', level: 300, sem: FIRST, lecturers: ['Dr. Bello'], active: true },
          { code: 'CSC 305', title: 'Algorithms & Complexity', level: 300, sem: FIRST, lecturers: ['Dr. Bello'], active: true },
        ],
      },
      {
        code: 'MTH',
        name: 'Mathematics',
        head: 'Dr. K. Salami',
        programmes: [
          { code: 'MTH', name: 'B.Sc. Mathematics', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'MTH 101', title: 'Elementary Mathematics I', level: 100, sem: FIRST, lecturers: ['Dr. K. Salami'], active: true },
          { code: 'MTH 201', title: 'Mathematical Methods I', level: 200, sem: FIRST, lecturers: ['Dr. K. Salami'], active: true },
        ],
      },
      {
        code: 'MCB',
        name: 'Microbiology',
        head: 'Dr. (Mrs.) O. T. Falade',
        programmes: [
          { code: 'MCB', name: 'B.Sc. Microbiology', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'MCB 201', title: 'General Microbiology I', level: 200, sem: FIRST, lecturers: ['Dr. O. T. Falade'], active: true },
        ],
      },
      {
        code: 'PWE',
        name: 'Physics with Electronics',
        head: 'Dr. N. O. Adebisi',
        programmes: [
          { code: 'PWE', name: 'B.Sc. Physics with Electronics', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'PHY 101', title: 'General Physics I', level: 100, sem: FIRST, lecturers: ['Dr. N. O. Adebisi'], active: true },
          { code: 'PWE 201', title: 'Circuit Theory & Electronics I', level: 200, sem: FIRST, lecturers: ['Dr. N. O. Adebisi'], active: true },
        ],
      },
      {
        code: 'STA',
        name: 'Statistics',
        head: 'Dr. A. A. Quadri',
        programmes: [
          { code: 'STA', name: 'B.Sc. Statistics', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'STA 201', title: 'Probability Theory I', level: 200, sem: FIRST, lecturers: ['Dr. A. A. Quadri'], active: true },
        ],
      },
      {
        code: 'ZOO',
        name: 'Zoology',
        head: 'Dr. E. O. Oshodi',
        programmes: [
          { code: 'ZOO', name: 'B.Sc. Zoology', award: 'B.Sc.', durationYears: 4 },
        ],
        courses: [
          { code: 'ZOO 201', title: 'Invertebrate Zoology', level: 200, sem: FIRST, lecturers: ['Dr. E. O. Oshodi'], active: true },
        ],
      },
    ],
  },
  {
    code: 'COET',
    name: 'College of Engineering and Technology',
    dean: 'Prof. E. Johnson',
    departments: [
      {
        code: 'ABE',
        name: 'Agricultural and Biosystems Engineering',
        head: 'Engr. Dr. S. A. Olawale',
        programmes: [
          { code: 'ABE', name: 'B.Eng. Agricultural & Biosystems Engineering', award: 'B.Eng.', durationYears: 5 },
        ],
        courses: [
          { code: 'ABE 201', title: 'Introduction to Biosystems Engineering', level: 200, sem: FIRST, lecturers: ['Engr. Dr. S. A. Olawale'], active: true },
        ],
      },
      {
        code: 'CHE',
        name: 'Chemical Engineering',
        head: 'Engr. Dr. B. A. Adelekan',
        programmes: [
          { code: 'CHE', name: 'B.Eng. Chemical Engineering', award: 'B.Eng.', durationYears: 5 },
        ],
        courses: [
          { code: 'CHE 201', title: 'Chemical Engineering Fundamentals', level: 200, sem: FIRST, lecturers: ['Engr. Dr. B. A. Adelekan'], active: true },
        ],
      },
      {
        code: 'CVE',
        name: 'Civil and Construction Engineering',
        head: 'Engr. Dr. O. F. Bamgbose',
        programmes: [
          { code: 'CVE', name: 'B.Eng. Civil & Construction Engineering', award: 'B.Eng.', durationYears: 5 },
        ],
        courses: [
          { code: 'CVE 201', title: 'Strength of Materials I', level: 200, sem: FIRST, lecturers: ['Engr. Dr. O. F. Bamgbose'], active: true },
        ],
      },
      {
        code: 'CPE',
        name: 'Computer Engineering',
        head: 'Engr. Dr. A. K. Alonge',
        programmes: [
          { code: 'CPE', name: 'B.Eng. Computer Engineering', award: 'B.Eng.', durationYears: 5 },
        ],
        courses: [
          { code: 'CPE 201', title: 'Digital Logic Design', level: 200, sem: FIRST, lecturers: ['Engr. Dr. A. K. Alonge'], active: true },
        ],
      },
      {
        code: 'EEE',
        name: 'Electrical and Electronics Engineering',
        head: 'Engr. Prof. M. O. Lawal',
        programmes: [
          { code: 'EEE', name: 'B.Eng. Electrical & Electronics Engineering', award: 'B.Eng.', durationYears: 5 },
        ],
        courses: [
          { code: 'EEE 201', title: 'Electric Circuit Theory', level: 200, sem: FIRST, lecturers: ['Engr. Prof. M. O. Lawal'], active: true },
        ],
      },
      {
        code: 'FST',
        name: 'Food Science and Technology',
        head: 'Dr. (Mrs.) T. I. Oyewole',
        programmes: [
          { code: 'FST', name: 'B.Sc. Food Science and Technology', award: 'B.Sc.', durationYears: 5 },
        ],
        courses: [
          { code: 'FST 201', title: 'Introduction to Food Technology', level: 200, sem: FIRST, lecturers: ['Dr. T. I. Oyewole'], active: true },
        ],
      },
      {
        code: 'MEE',
        name: 'Mechanical Engineering',
        head: 'Engr. F. Alabi',
        programmes: [
          { code: 'MEE', name: 'B.Eng. Mechanical Engineering', award: 'B.Eng.', durationYears: 5 },
        ],
        courses: [
          { code: 'MEE 201', title: 'Engineering Mechanics I', level: 200, sem: FIRST, lecturers: ['Engr. F. Alabi'], active: true },
        ],
      },
      {
        code: 'MTE',
        name: 'Mechatronics Engineering',
        head: 'Engr. Dr. K. O. Gbadamosi',
        programmes: [
          { code: 'MTE', name: 'B.Eng. Mechatronics Engineering', award: 'B.Eng.', durationYears: 5 },
        ],
        courses: [
          { code: 'MTE 201', title: 'Introduction to Mechatronics', level: 200, sem: FIRST, lecturers: ['Engr. Dr. K. O. Gbadamosi'], active: true },
        ],
      },
    ],
  },
];

/** Courses every student on the programme takes. */
const UNITS_DEFAULT = 3;

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function seedRoles() {
  const ids: Record<string, string> = {};
  for (const r of ROLES) {
    const row = await prisma.role.upsert({ where: { key: r.key }, update: { name: r.name }, create: r });
    ids[r.key] = row.id;
  }
  return ids;
}

/**
 * Removes role rows and grants that are no longer part of the three-role model.
 * Safe on a fresh database (nothing matches) and on one seeded before the
 * reduction. Runs before seedUsers so no account is left pointing at a deleted
 * role.
 */
async function removeLegacyRoles() {
  const keep = ROLES.map((r) => r.key);
  const grants = await prisma.userRole.deleteMany({ where: { role: { key: { notIn: keep } } } });
  const perms = await prisma.rolePermission.deleteMany({ where: { role: { key: { notIn: keep } } } });
  const roles = await prisma.role.deleteMany({ where: { key: { notIn: keep } } });
  if (grants.count || perms.count || roles.count) {
    console.log(
      `  removed legacy roles: ${roles.count} role(s), ${grants.count} grant(s), ${perms.count} permission(s)`,
    );
  }
}

/** Deletes the old officer/invigilator demo accounts, keeping any audit history. */
async function removeLegacyDemoUsers() {
  for (const email of LEGACY_DEMO_EMAILS) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, names: true } });
    if (!user) continue;

    try {
      await prisma.$transaction([
        prisma.authSession.deleteMany({ where: { userId: user.id } }),
        prisma.userRole.deleteMany({ where: { userId: user.id } }),
        prisma.userPermission.deleteMany({ where: { userId: user.id } }),
        prisma.passwordHistory.deleteMany({ where: { userId: user.id } }),
        prisma.user.delete({ where: { id: user.id } }),
      ]);
      console.log(`  removed legacy demo account ${email}`);
    } catch {
      // Audit rows (or other history) reference the account: keep the record,
      // but make it unusable and role-less.
      await prisma.$transaction([
        prisma.userRole.deleteMany({ where: { userId: user.id } }),
        prisma.authSession.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'ROLE_REMOVED' },
        }),
        prisma.user.update({ where: { id: user.id }, data: { status: 'DEACTIVATED' } }),
      ]);
      console.log(`  deactivated legacy demo account ${email} (history retained)`);
    }
  }
}

async function seedUsers(roleIds: Record<string, string>, passwordHash: string) {
  const byName = new Map<string, string>();

  for (const u of USERS) {
    const matricNo = 'matricNo' in u ? u.matricNo : undefined;
    const staffId = 'staffId' in u ? u.staffId : undefined;

    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        names: u.names,
        passwordHash,
        passwordSetAt: new Date(),
        status: 'ACTIVE',
        failedLoginCount: 0,
        lockedUntil: null,
      },
      create: {
        names: u.names,
        email: u.email,
        matricNo,
        staffId,
        passwordHash,
        passwordSetAt: new Date(),
        status: 'ACTIVE',
      },
    });

    // user_roles has partial unique indexes that Prisma cannot see, so a plain
    // upsert is not available here — check first, exactly as the API does.
    const existing = await prisma.userRole.findFirst({
      where: { userId: user.id, roleId: roleIds[u.role], scopeType: 'GLOBAL' },
    });
    if (!existing) {
      await prisma.userRole.create({
        data: { userId: user.id, roleId: roleIds[u.role], scopeType: 'GLOBAL' },
      });
    }

    // Gives security.passwordExpiryDays a row to age against.
    const history = await prisma.passwordHistory.findFirst({ where: { userId: user.id } });
    if (!history) {
      await prisma.passwordHistory.create({ data: { userId: user.id, passwordHash } });
    }

    byName.set(u.names, user.id);
    console.log(`  ${u.role.padEnd(13)} ${u.email}`);
  }

  return byName;
}

async function seedGradeBands() {
  for (const b of GRADE_BANDS) {
    const data = {
      minPercent: b.minPercent,
      maxPercent: b.maxPercent,
      point: b.point,
      label: b.label,
    };
    await prisma.gradeBand.upsert({
      where: { grade: b.grade },
      update: data,
      create: { grade: b.grade, ...data },
    });
  }
  console.log(`  ${GRADE_BANDS.length} grade bands (A–F, 5-point scale)`);
}

async function seedSessions() {
  // Only one row may carry is_current (partial unique index), so clear the flag
  // off any other session before claiming it.
  await prisma.academicSession.updateMany({
    where: { isCurrent: true, NOT: { name: CURRENT_SESSION } },
    data: { isCurrent: false },
  });

  const current = await prisma.academicSession.upsert({
    where: { name: CURRENT_SESSION },
    update: { isCurrent: true, closedAt: null },
    create: {
      name: CURRENT_SESSION,
      startsOn: date('2026-10-05'),
      endsOn: date('2027-08-14'),
      isCurrent: true,
    },
  });

  const previous = await prisma.academicSession.upsert({
    where: { name: PREVIOUS_SESSION },
    update: {},
    create: {
      name: PREVIOUS_SESSION,
      startsOn: date('2025-10-06'),
      endsOn: date('2026-08-15'),
      isCurrent: false,
      closedAt: date('2026-08-15'),
    },
  });

  const SEMESTERS = [
    { sessionId: current.id, name: FIRST, startsOn: date('2026-10-05'), endsOn: date('2027-02-05') },
    { sessionId: current.id, name: SECOND, startsOn: date('2027-02-22'), endsOn: date('2027-08-14') },
    { sessionId: previous.id, name: FIRST, startsOn: date('2025-10-06'), endsOn: date('2026-02-06') },
    { sessionId: previous.id, name: SECOND, startsOn: date('2026-02-23'), endsOn: date('2026-08-15') },
  ];
  for (const s of SEMESTERS) {
    await prisma.semester.upsert({
      where: { sessionId_name: { sessionId: s.sessionId, name: s.name } },
      update: { startsOn: s.startsOn, endsOn: s.endsOn },
      create: s,
    });
  }

  console.log(`  2 academic sessions (${CURRENT_SESSION} current), 4 semesters`);
  return current;
}

async function seedStructure() {
  /** lecturer name -> course ids, resolved once all courses exist. */
  const courseIds = new Map<string, string>();
  const wanted = new Map<string, string[]>();
  let colleges = 0;
  let departments = 0;
  let programmes = 0;
  let courses = 0;

  for (const c of STRUCTURE) {
    const college = await prisma.college.upsert({
      where: { code: c.code },
      update: { name: c.name, dean: c.dean },
      create: { code: c.code, name: c.name, dean: c.dean },
    });
    colleges++;

    for (const d of c.departments) {
      const department = await prisma.department.upsert({
        where: { collegeId_code: { collegeId: college.id, code: d.code } },
        update: { name: d.name, headName: d.head },
        create: { collegeId: college.id, code: d.code, name: d.name, headName: d.head },
      });
      departments++;

      const programmeIds: string[] = [];
      for (const p of d.programmes) {
        const programme = await prisma.programme.upsert({
          where: { departmentId_code: { departmentId: department.id, code: p.code } },
          update: { name: p.name, award: p.award, durationYears: p.durationYears },
          create: {
            departmentId: department.id,
            code: p.code,
            name: p.name,
            award: p.award,
            durationYears: p.durationYears,
          },
        });
        programmeIds.push(programme.id);
        programmes++;
      }

      for (const k of d.courses) {
        const course = await prisma.course.upsert({
          where: { departmentId_code: { departmentId: department.id, code: k.code } },
          update: {
            title: k.title,
            units: UNITS_DEFAULT,
            level: k.level,
            defaultSemester: k.sem,
            active: k.active,
          },
          create: {
            departmentId: department.id,
            code: k.code,
            title: k.title,
            units: UNITS_DEFAULT,
            level: k.level,
            defaultSemester: k.sem,
            active: k.active,
          },
        });
        courses++;
        courseIds.set(`${d.code}|${k.code}`, course.id);

        // Every course this department teaches belongs to each of its programmes.
        for (const programmeId of programmeIds) {
          await prisma.programmeCourse.upsert({
            where: { programmeId_courseId: { programmeId, courseId: course.id } },
            update: { level: k.level, semester: k.sem },
            create: {
              programmeId,
              courseId: course.id,
              level: k.level,
              semester: k.sem,
              compulsory: true,
            },
          });
        }

        for (const lecturer of k.lecturers) {
          wanted.set(lecturer, [...(wanted.get(lecturer) ?? []), course.id]);
        }
      }
    }
  }

  console.log(`  ${colleges} colleges, ${departments} departments, ${programmes} programmes, ${courses} courses`);
  return { courseIds, wanted };
}

/**
 * Links the fixture's lecturer *names* to real staff accounts. Only names that
 * match a seeded user exactly are assigned — the rest have no account yet, and
 * are reported rather than silently dropped.
 */
async function seedCourseAssignments(
  sessionId: string,
  wanted: Map<string, string[]>,
  usersByName: Map<string, string>,
) {
  let assigned = 0;
  const unassigned = new Set<string>();

  for (const [name, ids] of wanted) {
    const userId = usersByName.get(name);
    if (!userId) {
      unassigned.add(name);
      continue;
    }
    for (const courseId of ids) {
      await prisma.courseAssignment.upsert({
        where: {
          courseId_userId_sessionId_role: {
            courseId,
            userId,
            sessionId,
            role: 'LECTURER',
          },
        },
        update: {},
        create: { courseId, userId, sessionId, role: 'LECTURER' },
      });
      assigned++;
    }
  }

  console.log(`  ${assigned} course assignment(s) for ${wanted.size - unassigned.size} lecturer account(s)`);
  if (unassigned.size) {
    console.log(
      `  note: ${unassigned.size} named lecturer(s) have no account yet — ` +
        `import them via /admin/users/import to bind their courses`,
    );
  }
}

/** Gives the demo student a programme and a timetable so the portal is not empty. */
async function seedStudent(studentId: string, sessionId: string, courseIds: Map<string, string>) {
  const programme = await prisma.programme.findFirst({
    where: { code: 'CSC', department: { code: 'CSC' } },
    select: { id: true },
  });
  if (!programme) return;

  await prisma.studentProfile.upsert({
    where: { userId: studentId },
    update: { programmeId: programme.id, level: 400 },
    // Matric no. is CSC/2022/305; 400 level is final-year standing for 2026/2027.
    create: { userId: studentId, programmeId: programme.id, level: 400, admissionYear: 2022 },
  });

  let enrolled = 0;
  for (const [key, courseId] of courseIds) {
    if (!key.startsWith('CSC|')) continue;
    await prisma.enrollment.upsert({
      where: { studentId_courseId_sessionId: { studentId, courseId, sessionId } },
      update: { status: 'ACTIVE' },
      create: { studentId, courseId, sessionId, status: 'ACTIVE' },
    });
    enrolled++;
  }
  console.log(`  demo student on B.Sc. Computer Science, ${enrolled} enrolment(s)`);
}

async function main() {
  const password = process.env.SEED_PASSWORD ?? 'ChangeMe123!';
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  console.log('Roles and demo accounts');
  const roleIds = await seedRoles();
  await removeLegacyRoles();
  await removeLegacyDemoUsers();
  const usersByName = await seedUsers(roleIds, passwordHash);

  console.log('\nGrading scale');
  await seedGradeBands();

  console.log('\nAcademic calendar');
  const session = await seedSessions();

  console.log('\nStructure');
  const { courseIds, wanted } = await seedStructure();

  console.log('\nTeaching and enrolment');
  await seedCourseAssignments(session.id, wanted, usersByName);
  const studentId = usersByName.get('Nifemi Osadare');
  if (studentId) await seedStudent(studentId, session.id, courseIds);

  console.log(`\nAll seeded accounts use password: ${password}`);
  console.log('Rotate it before this leaves your machine.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
