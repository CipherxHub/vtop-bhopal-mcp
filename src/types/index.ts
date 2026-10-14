export interface Credentials {
  username: string;
  password: string;
}

export interface AttendanceRecord {
  courseCode: string;
  courseName: string;
  courseType: string;
  slot: string;
  /**
   * Parsed counts. null when VTOP prints no usable number ("-", blank) —
   * unknown, never zero. A real zero means classes happened and none were
   * attended; null means the figures are not on the page at all.
   */
  attended: number | null;
  total: number | null;
  percentage: number | null;
}

export interface TimetableSlot {
  day: string;
  startTime: string;
  endTime: string;
  courseCode: string;
  courseName: string;
  courseType: string;
  venue: string;
  faculty: string;
  slots?: string;
  credits?: number;
  /**
   * Every weekly meeting of this course from the timetable grid. A course with
   * two slots a week (e.g. "A11+A12+A13") has one entry per slot per day. The
   * scalar day/startTime/endTime above mirror the first of these.
   */
  sessions?: {
    day: string;
    slot: string;
    type: "THEORY" | "LAB";
    startTime: string;
    endTime: string;
    venue: string;
  }[];
}

export interface MarksRecord {
  courseCode: string;
  courseName: string;
  courseType: string;
  /**
   * VTOP's short course-mode code from the marks table: LTM, LPM or LTPM.
   * Decides which assessment components the course is expected to have.
   */
  courseMode?: string;
  slot: string;
  marks: {
    component: string;
    /** Structural maximum; null when the cell carries no number. */
    maxMarks: number | null;
    /** null when unpublished — never a scored zero. */
    scored: number | null;
    maxWeightage: number | null;
    /** null when unpublished; contributes nothing to banked totals. */
    weightage: number | null;
    average: number | null;
    status: string;
  }[];
}

export interface ExamSchedule {
  examType: string;
  courseCode: string;
  courseName: string;
  slot: string;
  examDate: string;
  session: string;
  time: string;
  venue: string;
  seatNo: string;
  seatLocation: string;
}

export interface GradeRecord {
  courseCode: string;
  courseName: string;
  courseType: string;
  credits: number;
  grade: string;
  gradePoints: number;
}

export interface GradeHistory {
  semesters: {
    semester: string;
    /**
     * null when the term holds only P (pass) / non-graded courses, so there is
     * no GPA-bearing credit. That is NOT a GPA of 0.
     */
    gpa: number | null;
    credits: number;
    grades: GradeRecord[];
  }[];
  cgpa: number;
  totalCredits: number;
}

export interface StudentProfile {
  name: string;
  registrationNumber: string;
  applicationNumber: string;
  program: string;
  branch: string;
  school: string;
  email: string;
  phone: string;
  bloodGroup: string;
}

export interface Semester {
  id: string;
  name: string;
}

export interface CurriculumProgressRow {
  /** Display name, e.g. "Discipline Core" or "Foreign Language" */
  name: string;
  /** Only present on basket rows; the parent distribution-type code (e.g. "FCHSSM") */
  distributionType?: string;
  creditsRequired: number;
  creditsEarned: number;
  creditsRemaining: number;
  /** 0–100, rounded to 1 decimal place. 100 means fully satisfied. */
  percentComplete: number;
}

export interface GradeDistribution {
  S: number;
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
  F: number;
  N: number;
}

export interface CurriculumProgress {
  totals: {
    creditsRegistered: number;
    creditsRequired: number;
    creditsEarned: number;
    creditsRemaining: number;
    percentComplete: number;
    cgpa: number;
  };
  /** Per high-level distribution type (Foundation Core, Discipline Core, Electives, etc.) */
  distributionTypes: CurriculumProgressRow[];
  /** Per fine-grained basket (Foreign Language, HSM Elective, Extra-curricular, etc.) */
  baskets: CurriculumProgressRow[];
  /** Count of each grade earned across the whole degree. */
  gradeDistribution: GradeDistribution;
}

/** One accordion section of the full student profile, exactly as VTOP groups it. */
export interface ProfileSection {
  /** E.g. "PERSONAL INFORMATION", "HOSTEL INFORMATION". */
  title: string;
  /** Label → value as printed, e.g. { "DATE OF BIRTH": "02-Nov-2004" }. */
  fields: Record<string, string>;
}

/** Proctor details. Verbatim strings — an empty cabin renders as "null". */
export interface ProctorDetails {
  facultyId: string;
  name: string;
  designation: string;
  school: string;
  department: string;
  cabin: string;
  email: string;
  intercom: string;
  mobile: string;
}

/** One admission document line from the acknowledgment checklist. */
export interface Acknowledgment {
  document: string;
  /** Verbatim: "Submitted" / "Not Applicable" / "Not Submitted". */
  status: string;
}

/** One course row from a programme curriculum basket. */
export interface CurriculumCourse {
  code: string;
  title: string;
  type: string;
  version: string;
  l: number;
  t: number;
  p: number;
  j: number;
  credits: number;
  /**
   * Whether VTOP itself marks this row completed (the `bg-success` row class).
   * Read from the page, never recomputed — cross-check against grades instead.
   */
  vtopMarkedCompleted: boolean;
}

/** One programme-curriculum category and its courses. */
export interface CurriculumBasket {
  category: string;
  courses: CurriculumCourse[];
}

/** One course the student has not yet completed. */
export interface PendingSubject extends CurriculumCourse {
  /** Latest grade on record, if the course was attempted before. */
  latestGrade: string | null;
  completedPerGrades: boolean;
}

/** A course where VTOP's own completion marking disagrees with grade history. */
export interface CompletionDiscrepancy {
  courseCode: string;
  courseTitle: string;
  vtopMarkedCompleted: boolean;
  gradeBasedCompleted: boolean;
  latestGrade: string | null;
}

/** One fee receipt line. */
export interface FeeReceipt {
  receiptNumber: string;
  date: string;
  amount: number;
  campus: string;
}
