export interface Credentials {
  username: string;
  password: string;
}

export interface AttendanceRecord {
  courseCode: string;
  courseName: string;
  courseType: string;
  slot: string;
  attended: number;
  total: number;
  percentage: number;
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
    maxMarks: number;
    scored: number;
    maxWeightage: number;
    weightage: number;
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
