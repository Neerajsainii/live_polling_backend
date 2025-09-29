const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Configure Socket.io with CORS
const io = socketIo(server, {
  cors: {
    origin: [
      "http://localhost:5173", 
      "http://localhost:5174", 
      "http://localhost:3000",
      "https://live-polling-gules.vercel.app",
      "https://*.vercel.app"
    ],
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: [
    "http://localhost:5173", 
    "http://localhost:5174", 
    "http://localhost:3000",
    "https://live-polling-gules.vercel.app",
    "https://*.vercel.app"
  ],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api', limiter);

// In-memory data storage (in production, use a database)
let polls = new Map();
let pollHistory = [];
let activeParticipants = new Map();
let chatMessages = [];
let kickedOutStudents = new Set();
let currentPoll = null;

// Utility function to create safe poll response
function createPollResponse(poll) {
  if (!poll) return null;
  
  return {
    id: poll.id,
    question: poll.question,
    options: poll.options,
    duration: poll.duration,
    correctAnswer: poll.correctAnswer, // Include correct answer for results
    isActive: poll.isActive,
    startTime: poll.startTime,
    endTime: poll.endTime,
    timeLeft: poll.timeLeft,
    teacherId: poll.teacherId,
    teacherName: poll.teacherName,
    createdAt: poll.createdAt,
    results: poll.results || {},
    finalResults: poll.finalResults || {},
    summary: poll.summary || null,
    responses: poll.responses || {}
  };
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get current poll status
app.get('/api/poll/current', (req, res) => {
  try {
    if (!currentPoll) {
      return res.json({ poll: null, message: 'No active poll' });
    }

    res.json({
      poll: createPollResponse(currentPoll),
      participants: Array.from(activeParticipants.values()),
      chatMessages
    });

  } catch (error) {
    console.error('Error fetching current poll:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get poll history (Teacher only)
app.get('/api/poll/history', (req, res) => {
  try {
    const { teacherId } = req.query;

    if (!teacherId) {
      return res.status(400).json({ error: 'Teacher ID is required' });
    }

    // Filter history for this teacher only
    const teacherHistory = pollHistory.filter(poll => poll.teacherId === teacherId);

    // Transform the data for frontend display
    const formattedHistory = teacherHistory.map(poll => ({
      id: poll.id,
      question: poll.question,
      options: poll.options,
      results: poll.finalResults || poll.results,
      summary: poll.summary,
      totalVotes: poll.summary?.totalResponses || 0,
      correctAnswer: poll.correctAnswer,
      createdAt: poll.createdAt,
      endTime: poll.endTime
    }));

    res.json({
      history: formattedHistory,
      total: formattedHistory.length
    });

  } catch (error) {
    console.error('Error fetching poll history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user response for a specific poll
app.get('/api/poll/:pollId/response/:userId', (req, res) => {
  try {
    const { pollId, userId } = req.params;
    
    const poll = polls.get(pollId);
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    const userResponse = poll.responses[userId];
    if (!userResponse) {
      return res.json({ hasResponded: false, response: null });
    }

    res.json({
      hasResponded: true,
      response: userResponse.selectedOption,
      isCorrect: userResponse.isCorrect,
      correctAnswer: poll.options[poll.correctAnswer]
    });

  } catch (error) {
    console.error('Error fetching user response:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new poll (Teacher only)
app.post('/api/poll/create', (req, res) => {
  try {
    const { question, options, duration = 60, teacherId, teacherName, correctAnswer = 0 } = req.body;

    // Validation
    if (!question || !options || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ 
        error: 'Question and at least 2 options are required' 
      });
    }

    if (!teacherId || !teacherName) {
      return res.status(400).json({ 
        error: 'Teacher ID and name are required' 
      });
    }

    // Check if there's already an active poll
    if (currentPoll && currentPoll.isActive) {
      return res.status(409).json({ 
        error: 'There is already an active poll. Please end it before creating a new one.' 
      });
    }

    const pollId = uuidv4();
    const poll = {
      id: pollId,
      question: question.trim(),
      options: options.map(opt => opt.trim()).filter(opt => opt.length > 0),
      duration: Math.min(Math.max(duration, 10), 300), // Between 10-300 seconds
      correctAnswer: Math.max(0, Math.min(correctAnswer, options.length - 1)), // Validate correct answer index
      isActive: false,
      responses: {},
      results: {},
      startTime: null,
      endTime: null,
      timeLeft: duration,
      teacherId,
      teacherName,
      createdAt: new Date().toISOString()
    };

    polls.set(pollId, poll);
    currentPoll = poll;

    res.status(201).json({ 
      poll: createPollResponse(poll),
      message: 'Poll created successfully'
    });

  } catch (error) {
    console.error('Error creating poll:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start a poll (Teacher only)
app.post('/api/poll/:pollId/start', (req, res) => {
  try {
    const { pollId } = req.params;
    const { teacherId } = req.body;

    const poll = polls.get(pollId);
    
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    if (poll.teacherId !== teacherId) {
      return res.status(403).json({ error: 'Only the poll creator can start this poll' });
    }

    if (poll.isActive) {
      return res.status(409).json({ error: 'Poll is already active' });
    }

    // Start the poll
    poll.isActive = true;
    poll.startTime = new Date().toISOString();
    poll.endTime = new Date(Date.now() + poll.duration * 1000).toISOString();
    poll.timeLeft = poll.duration;
    poll.responses = {};
    poll.results = {};

    // Initialize results for each option
    poll.options.forEach(option => {
      poll.results[option] = { count: 0, participants: [] };
    });

    // Clear previous chat messages for new poll
    chatMessages = [];

    // Broadcast poll start to all clients
    io.emit('pollStarted', {
      poll: createPollResponse(poll),
      participants: Array.from(activeParticipants.values())
    });

    // Start timer
    const timer = setInterval(() => {
      poll.timeLeft--;
      
      // Broadcast time update
      io.emit('timerUpdate', { timeLeft: poll.timeLeft });

      if (poll.timeLeft <= 0) {
        clearInterval(timer);
        endPoll(poll);
      }
    }, 1000);

    res.json({ 
      poll: createPollResponse(poll),
      message: 'Poll started successfully'
    });

  } catch (error) {
    console.error('Error starting poll:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// End poll function
function endPoll(poll) {
  poll.isActive = false;
  poll.endTime = new Date().toISOString();
  poll.timeLeft = 0;

  // Calculate final results with correct/incorrect analysis
  const finalResults = {};
  let totalResponses = 0;
  let correctResponses = 0;

  poll.options.forEach((option, index) => {
    const count = poll.results[option]?.count || 0;
    const isCorrect = index === poll.correctAnswer;
    
    finalResults[option] = {
      count,
      percentage: 0,
      isCorrect
    };
    
    totalResponses += count;
    if (isCorrect) {
      correctResponses += count;
    }
  });

  // Calculate percentages
  if (totalResponses > 0) {
    poll.options.forEach(option => {
      finalResults[option].percentage = Math.round((finalResults[option].count / totalResponses) * 100);
    });
  }

  // Add correct/incorrect summary
  const correctPercentage = totalResponses > 0 ? Math.round((correctResponses / totalResponses) * 100) : 0;
  const incorrectPercentage = 100 - correctPercentage;

  poll.finalResults = finalResults;
  poll.summary = {
    totalResponses,
    correctResponses,
    incorrectResponses: totalResponses - correctResponses,
    correctPercentage,
    incorrectPercentage,
    correctAnswer: poll.options[poll.correctAnswer]
  };

  // Add to history
  pollHistory.push({
    ...poll,
    participants: Array.from(activeParticipants.values())
  });

  // Broadcast poll end with all the calculated results
  console.log('Poll ended. Broadcasting results:', {
    finalResults,
    summary: poll.summary,
    totalResponses
  });

  io.emit('pollEnded', {
    poll: createPollResponse(poll),
    results: finalResults,
    summary: poll.summary
  });
}

// Submit response to poll (Student only)
app.post('/api/poll/:pollId/response', (req, res) => {
  try {
    const { pollId } = req.params;
    const { studentId, studentName, selectedOption } = req.body;

    // Check if student is kicked out
    if (kickedOutStudents.has(studentId)) {
      return res.status(403).json({ error: 'You have been removed from this session' });
    }

    const poll = polls.get(pollId);
    
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    if (!poll.isActive) {
      return res.status(400).json({ error: 'Poll is not currently active' });
    }

    if (!poll.options.includes(selectedOption)) {
      return res.status(400).json({ error: 'Invalid option selected' });
    }

    // Check if student already responded
    if (poll.responses[studentId]) {
      return res.status(409).json({ error: 'You have already responded to this poll' });
    }

    // Record response
    poll.responses[studentId] = {
      studentId,
      studentName,
      selectedOption,
      timestamp: new Date().toISOString(),
      isCorrect: poll.options[poll.correctAnswer] === selectedOption
    };

    // Update results
    if (!poll.results[selectedOption]) {
      poll.results[selectedOption] = { count: 0, participants: [] };
    }
    poll.results[selectedOption].count++;
    poll.results[selectedOption].participants.push({ studentId, studentName });

    console.log(`Response recorded: ${studentName} selected ${selectedOption}. Current results:`, poll.results);

    // Broadcast updated results
    io.emit('responseSubmitted', {
      poll: createPollResponse(poll),
      results: poll.results,
      newResponse: {
        studentId,
        studentName,
        selectedOption
      }
    });

    res.json({ 
      message: 'Response submitted successfully',
      isCorrect: poll.options[poll.correctAnswer] === selectedOption
    });

  } catch (error) {
    console.error('Error submitting response:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's response for a specific poll (Student only)
app.get('/api/poll/:pollId/user/:userId/response', (req, res) => {
  try {
    const { pollId, userId } = req.params;

    const poll = polls.get(pollId);
    
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    const userResponse = poll.responses[userId];
    
    if (!userResponse) {
      return res.json({ 
        hasResponded: false,
        message: 'User has not responded to this poll'
      });
    }

    res.json({
      hasResponded: true,
      response: userResponse.selectedOption,
      isCorrect: userResponse.isCorrect,
      correctAnswer: poll.options[poll.correctAnswer],
      timestamp: userResponse.timestamp
    });

  } catch (error) {
    console.error('Error fetching user response:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Join as participant (Student)
app.post('/api/participant/join', (req, res) => {
  try {
    const { studentId, studentName } = req.body;

    if (!studentId || !studentName) {
      return res.status(400).json({ error: 'Student ID and name are required' });
    }

    // Check if student is kicked out
    if (kickedOutStudents.has(studentId)) {
      return res.status(403).json({ error: 'You have been removed from this session' });
    }

    // Add to active participants
    activeParticipants.set(studentId, {
      id: studentId,
      name: studentName,
      role: 'student',
      joinedAt: new Date().toISOString()
    });

    res.json({ 
      message: 'Successfully joined as participant',
      participant: activeParticipants.get(studentId)
    });

  } catch (error) {
    console.error('Error joining as participant:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get chat messages
app.get('/api/chat/messages', (req, res) => {
  try {
    res.json({ messages: chatMessages });
  } catch (error) {
    console.error('Error getting chat messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get poll history (Teacher only)
app.get('/api/poll/history', (req, res) => {
  try {
    res.json({ polls: pollHistory });
  } catch (error) {
    console.error('Error getting poll history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Join as teacher
  socket.on('joinTeacher', (data) => {
    const { teacherId, teacherName } = data;
    socket.join('teachers');
    socket.teacherId = teacherId;
    socket.teacherName = teacherName;
    socket.role = 'teacher';
    
    console.log(`Teacher ${teacherName} joined`);
    
    // Send current state
    socket.emit('connectionEstablished', {
      role: 'teacher',
      currentPoll: currentPoll ? createPollResponse(currentPoll) : null,
      participants: Array.from(activeParticipants.values()),
      chatMessages
    });
  });

  // Join as participant/student
  socket.on('joinParticipant', (data) => {
    const { studentId, studentName } = data;
    
    // Check if kicked out
    if (kickedOutStudents.has(studentId)) {
      socket.emit('kickedOut', { reason: 'You have been removed from this session' });
      return;
    }
    
    socket.join('participants');
    socket.studentId = studentId;
    socket.studentName = studentName;
    socket.role = 'student';
    
    // Add to active participants
    activeParticipants.set(studentId, {
      id: studentId,
      name: studentName,
      role: 'student',
      joinedAt: new Date().toISOString()
    });
    
    console.log(`Student ${studentName} joined`);
    
    // Notify all clients of new participant
    io.emit('participantJoined', {
      participant: activeParticipants.get(studentId),
      participants: Array.from(activeParticipants.values())
    });
    
    // Send current state to new participant
    socket.emit('connectionEstablished', {
      role: 'student',
      currentPoll: currentPoll ? createPollResponse(currentPoll) : null,
      participants: Array.from(activeParticipants.values()),
      chatMessages
    });
  });

  // Handle chat messages
  socket.on('sendMessage', (data) => {
    const { message, senderName, senderRole, senderId } = data;
    
    // Check if sender is kicked out (for students)
    if (senderRole === 'student' && kickedOutStudents.has(senderId)) {
      return;
    }

    const chatMessage = {
      id: uuidv4(),
      message: message.trim(),
      senderName,
      senderRole,
      senderId,
      timestamp: new Date().toISOString()
    };

    chatMessages.push(chatMessage);

    // Keep only last 100 messages
    if (chatMessages.length > 100) {
      chatMessages = chatMessages.slice(-100);
    }

    // Broadcast to all clients
    io.emit('newMessage', chatMessage);
  });

  // Handle kick participant (Teacher only)
  socket.on('kickParticipant', (data) => {
    if (socket.role !== 'teacher') return;
    
    const { studentId, reason = 'Removed by teacher' } = data;
    
    // Add to kicked out list
    kickedOutStudents.add(studentId);
    
    // Remove from active participants
    activeParticipants.delete(studentId);
    
    // Find and disconnect the student's socket
    const studentSocket = Array.from(io.sockets.sockets.values())
      .find(s => s.studentId === studentId);
    
    if (studentSocket) {
      studentSocket.emit('kickedOut', { reason });
      studentSocket.disconnect();
    }
    
    // Broadcast participant removal
    io.emit('participantRemoved', {
      studentId,
      reason,
      participants: Array.from(activeParticipants.values())
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    if (socket.role === 'student' && socket.studentId) {
      // Remove from active participants
      activeParticipants.delete(socket.studentId);
      
      // Notify all clients
      io.emit('participantRemoved', {
        studentId: socket.studentId,
        reason: 'disconnected',
        participants: Array.from(activeParticipants.values())
      });
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Socket.io server ready for connections`);
});

module.exports = server;
