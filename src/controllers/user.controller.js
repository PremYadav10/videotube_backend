import {asyncHandler} from '../utils/asyncHandler.js';
import {ApiError} from "../utils/ApiError.js";
import {User} from "../models/user.model.js";
import { Playlist } from "../models/playlist.model.js"
import {Subscription} from "../models/subscriptions.model.js"
import {uploadOnCloudinary,deleteFromCloudinary} from "../utils/cloudinary.js";
import {ApiResponse} from "../utils/ApiResponse.js"
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';


const generateAccessAndRefreshToken = async(userId)=>{
    try {
        const user = await User.findById(userId)

        const accessToken = user.generateAccessToken()
        const refreshToken = user.generateRefreshToken()

        user.refreshToken = refreshToken;
        await user.save({ validateBeforeCheck:false })

        return {accessToken,refreshToken}

    } catch (error) {
        throw new ApiError(500,"somthing went wrong while genrating refresh and access token")
    }
}

const registerUser = asyncHandler(async (req,res)=>{
    //get user datails from frontend (now by postmen)
    //validation - non empty
    //check if user already exist : username or email
    //check for images - check for avatar
    //images upload to cloudnary - check for avatar
    //create user object - create entry in db
    //remove password and refresh token field from response
    //check for user creation
    //retuen res


    const {username,email,fullname,password}=req.body
    // console.log("email :",email);

    if(
        [username,email,fullname,password].some((field)=>
        field?.trim() === "")
    ){
        throw new ApiError(400,"All Field Are Required")
    }

    const existedUser = await User.findOne({
        $or: [{username},{email}]
    })

    if(existedUser){
        throw new ApiError(409,"User with email and username already exist")
    }
    
    const avatarLocalPath = await req.files?.avatar[0]?.path;   //console log karke dekho for learning
    //console.log("avatarLocalPath",req.files);
    
    let coverImageLocalPath;
    if (req.files && Array.isArray(req.files.coverImage) && req.files.coverImage.length > 0) {
        coverImageLocalPath = req.files.coverImage[0].path
    }
    
    if(!avatarLocalPath){
        throw new ApiError(400,"Avatar file is required");
    }

    const avatar = await uploadOnCloudinary(avatarLocalPath)
    const coverImage = await uploadOnCloudinary(coverImageLocalPath)

    if(!avatar){
        throw new ApiError(400,"Avatar file is required");
    }

    const user = await User.create({
        fullname,
        username:username.toLowerCase(),
        avatar:avatar.url,
        coverImage:coverImage?.url || "",
        password,
        email
    })

    try {
        await Playlist.create({
            owner: user._id, // Link to the newly created user
            name: "Watch Later",
            description: "System-managed list for later viewing. (Do Not Delete)",
           // isPublic: false, // Default to private
           videos: [],
        });
        console.log(`Watch Later playlist created for new user: ${user.username}`);
    } catch (playlistError) {
        // Log the playlist error but proceed, as the user account is still valid
        console.error(`Failed to create Watch Later playlist for user ${user._id}:`, playlistError);
    }

    const createdUser = await User.findById(user._id).select(
        "-password -refreshToken"
    )

    if(!createdUser){
        throw new ApiError(500,"somthing went wrong while register the user")
    }

    return res.status(201).json(
        new ApiResponse(200,createdUser,"user registerd succesfully")
    )
}) 

const loginUser = asyncHandler(async (req,res)=>{

    //req body  - data
    const {username,password,email} = req.body

    //username or email check
    if(!(username || email)){
        throw new ApiError(400,"username or email required")
    }

    //find the user
    const user = await User.findOne({
        $or: [{username},{email}]
    })

    if(!user){
        throw new ApiError(404,"user dosn't exist")
    }

    //password check
   const isPasswordValid = await user.isPasswordCorrect(password);

   if(!isPasswordValid){
    throw new ApiError(401,"password is incorrect") 
   }

    //access and refresh token genrate 
    const {accessToken,refreshToken} = await generateAccessAndRefreshToken(user._id)

    const loggedInUser = await User.findById(user._id).select("-password -refreshToken")

    //send token || cookie

    const options = {
    httpOnly: true,
    secure: true,
    sameSite: "none"
}


    return res.status(200)
    .cookie("accessToken",accessToken,options)
    .cookie("refreshToken",refreshToken,options)
    .json(
        new ApiResponse(200,
            {
            user:loggedInUser ,accessToken , refreshToken
            },
            "User LoggedIn Succesfully"
    )
    )

})

const logoutUser = asyncHandler(async(req,res)=>{
    
    await User.findByIdAndUpdate(
        req.user._id,
        {
            // $set:{
            //     refreshToken:undefined
            // }
            
            //alternate and best approch

            $unset:{
                refreshToken:1 //remove field from document
            }
        },{
            new:true
        }
    )

    const options = {
    httpOnly: true,
    secure: true,
    sameSite: "none"
}


    return res
    .status(200) 
    .clearCookie("accessToken",options)
    .clearCookie("refreshToken",options)
    .json(new ApiResponse(200,{},"User Logged Out"))
});

const refreshAccessToken = asyncHandler( async(req,res) => {
            console.log("0");

    const incomingRefreshToken = req.cookies?.refreshToken || req.body?.refreshToken

    console.log("req.cookies",req.cookies);
    

    if (!incomingRefreshToken) {
        throw new ApiError(401,"unauthrizes request")
    }

            console.log("0.1");


    try {
        console.log("refresh token :",incomingRefreshToken);
        
        const decodedToken = jwt.verify(incomingRefreshToken,process.env.REFRESH_TOKEN_SECRET)
    
        console.log("1");
        
        const user = await User.findById(decodedToken?._id)
            console.log("2");

        if (!user) {
            throw new ApiError(401,"Invalid rquest token")
        }
    
        if (incomingRefreshToken !== user?.refreshToken) {
            throw new ApiError(401,"refresh token is expired or use")
        }
    
        const options = {
    httpOnly: true,
    secure: true,
    sameSite: "none"
}

        
        const {accessToken,newRefreshToken} = await generateAccessAndRefreshToken(user._id)
    
        return res
        .status(200)
        .cookie("accessToken",accessToken,options)
        .cookie("refreshToken",newRefreshToken,options)
        .json(
            new ApiResponse(
                200,
                {accessToken,newRefreshToken},
                "Aceess token Refreshed"
            )
        )
    } catch (error) {
        throw new ApiError(401,error?.message)
    }
})

const changeCurrentPassword = asyncHandler(async(req,res)=>{
    const {oldPassword,newPassword} = req.body

    const user = await User.findById(req.user?._id)
    const isPasswordCorrect = await user.isPasswordCorrect(oldPassword)

    if (!isPasswordCorrect) {
        throw new ApiError(400,"Invalid old password")
    }

    user.password = newPassword
    await user.save({validateBeforeSave:false})

    return res
    .status(200)
    .json(
        new ApiResponse(200,{},"Password Change succesfully")
    )

})

const getCurrentUser = asyncHandler(async(req,res)=>{
    return res.status(200)
            .json(
                new ApiResponse(200,
                    req.user,
                    "current user fatched")
            )
})

const updateAcoountDetails = asyncHandler(async(req,res)=>{
    const {fullname,email} = req.body

    if(!(fullname && email)){
        throw new ApiError(400,"email and fullname is required")
    }

    const user = await User.findByIdAndUpdate(
        req.user._id,
        {
            $set:{
                fullname:fullname,
                email:email
            }
        },
        {
            new:true
        }
    ).select("-password")

    return res
    .status(200)
    .json(new ApiResponse(200,
        user,
        "Acoount details updated succesfully"
    ))
    
})

const updateUserAvatar = asyncHandler(async(req,res)=>{
    const avatarLocalPath = req.file?.path

    if(!avatarLocalPath){
        throw new ApiError(400,"new avatar file is missing")
    }

    //  delete old image from cloudinary

    const avatar = await uploadOnCloudinary(avatarLocalPath)

    if(!avatar){
        throw new ApiError(400,"error while uploding avatar file")
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set:{
                avatar:avatar.url
            }
        },
        {new:true}
    ).select("-password")

    return res.status(200)
    .json(new ApiResponse(200,user,"avatar image updated"))
})

const updateUserCoverImage = asyncHandler(async(req,res)=>{
    const coverImageLocalPath = req.file?.path

    if(!coverImageLocalPath){
        throw new ApiError(400,"new cover image file is missing")
    }

    //  delete old image from cloudinary

    const coverImage = await uploadOnCloudinary(coverImageLocalPath)

    if(!coverImage){
        throw new ApiError(400,"error while uploding coverImage file")
    }

    const user = await User.findByIdAndUpdate(
        req.user?._id,
        {
            $set:{
                coverImage:coverImage.url
            }
        },
        {new:true}
    ).select("-password")

    return res.status(200)
    .json(new ApiResponse(200,user,"cover image updated"))
})

const getUserChannelProfile = asyncHandler(async(req,res)=>{
    const {username} = req.params

    if(!username){
        throw new ApiError(400,"username is missing")
    }

    const channel = await User.aggregate([
        {
            $match:{
                username:username?.toLowerCase()
            }
        },
        {
            $lookup:{
                from:"subscriptions",
                localField:"_id",
                foreignField:"channel",
                as:"subscribers"
            }
        },
        {
            $lookup:{
                from:"subscriptions",
                localField:"_id",
                foreignField:"subscriber",
                as:"subscribedTo"
            }
        },
        {
            $addFields:{
                subscribersCount:{
                    $size : "$subscribers"
                },
                channelsSubscribedToCount : {
                    $size : "$subscribedTo"
                },
                isSubscribed:{
                    $cond : {
                        if:{$in:[req.user?._id,"$subscribers.subscriber"]},
                        then:true,
                        else:true
                    }
                }
            }
        },
        {
            $project:{
                fullname:1,
                username:1,
                email:1,
                subscribersCount:1,
                channelsSubscribedToCount:1,
                isSubscribed:1,
                avatar:1,
                coverImage:1
            }
        }
    ])


    console.log("channel inside getUserChannelProfile :",channel);

    if(!channel?.length){
        throw new ApiError(404,"channel does not exists")
    }

    
    
    return res
    .status(200)
    .json(
        new ApiResponse(
            200,
            channel[0],
            "User channel fatced succesfully"
        )
    )

})

const getWatchHistory = asyncHandler(async(req,res)=>{

    const user = await User.aggregate([
        {
            $match:{
                _id : new mongoose.Types.ObjectId(req.user._id)
            }
        },
        {
            $lookup:{
                from:"videos",
                localField:"watchHistory",
                foreignField:"_id",
                as:"watchHistory",
                pipeline:[
                    {
                        $lookup:{
                            from:"users",
                            localField:"owner",
                            foreignField:"_id",
                            as:"owner",
                            pipeline:[
                                {
                                    $project:{
                                        fullname:1,
                                        username:1,
                                        avatar:1
                                    }
                                }
                            ]
                        }
                    },
                    {
                        $addFields:{
                            owner:{
                                $first:"$owner"
                            }
                        }
                    }
                ]
            }
        }
    ])

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                user[0].watchHistory,
                "watch history fatched successfully"
            )
        )
})


export {
    registerUser,
    loginUser,
    logoutUser,
    refreshAccessToken,
    changeCurrentPassword,
    getCurrentUser,
    updateAcoountDetails,
    updateUserAvatar,
    updateUserCoverImage,
    getUserChannelProfile,
    getWatchHistory
}

